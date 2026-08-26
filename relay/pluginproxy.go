package main

// Generic outbound proxy for plugins. This is what keeps "plugin = a folder
// plus env, redeploy" true for plugins that need an external API: without it,
// every such plugin needed bespoke relay code (the /steam endpoint was the
// proof), which kills the model. Operator-controlled on both axes:
//
//   PLUGIN_PROXY_HOSTS    comma list of exact hostnames plugins may reach
//   PLUGIN_PROXY_SECRETS  comma list of NAME=value; a request url may carry
//                         {{secret:NAME}} placeholders, substituted
//                         server-side so keys never reach clients
//
// GET /plugin-proxy?url=<https url> - the host must be allowlisted, the
// scheme https, redirects stay inside the allowlist, private/loopback IPs
// are refused at dial time (same SSRF stance as /og), responses are capped
// and briefly cached.

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const pluginProxyMaxBody = 2 << 20 // 2 MB
const pluginProxyCacheTTL = 5 * time.Minute

// Small response cache: upstream APIs rate limit, and a room of people
// loading the same card should cost one upstream call.
var pluginProxyCache sync.Map // key string -> pluginProxyCacheEntry

type pluginProxyCacheEntry struct {
	body        []byte
	contentType string
	expires     time.Time
}

func pluginProxyCached(key string) (pluginProxyCacheEntry, bool) {
	if v, ok := pluginProxyCache.Load(key); ok {
		e := v.(pluginProxyCacheEntry)
		if time.Now().Before(e.expires) {
			return e, true
		}
		pluginProxyCache.Delete(key)
	}
	return pluginProxyCacheEntry{}, false
}

func pluginProxyStore(key string, body []byte, contentType string) {
	pluginProxyCache.Store(key, pluginProxyCacheEntry{body: body, contentType: contentType, expires: time.Now().Add(pluginProxyCacheTTL)})
}

// Per-client fixed-window rate limit. The Origin check only holds honest
// browsers; without this the proxy is a free spender of the operator's API
// quotas for anyone with curl. A plain map under a mutex, NOT sync.Map:
// load-check-store on sync.Map was a TOCTOU where N concurrent requests all
// read the same stale count and all passed.
var (
	rateMu    sync.Mutex
	rateBy    = map[string]rateEntry{}
	lastSweep time.Time
)

type rateEntry struct {
	count   int
	resetAt time.Time
}

const pluginProxyRateLimit = 10
const pluginProxyRateWindow = time.Minute

// rateAllow enforces a fixed window per key. Callers namespace the key
// ("pp:"+ip, "mb:"+ip, ...) so hammering one feature cannot starve another.
func rateAllow(key string, limit int) bool {
	now := time.Now()
	rateMu.Lock()
	defer rateMu.Unlock()
	// Expired windows would otherwise accumulate one entry per client IP
	// forever; sweep opportunistically, at most once per window.
	if now.Sub(lastSweep) > pluginProxyRateWindow {
		lastSweep = now
		for k, e := range rateBy {
			if now.After(e.resetAt) {
				delete(rateBy, k)
			}
		}
	}
	e, ok := rateBy[key]
	if !ok || now.After(e.resetAt) {
		rateBy[key] = rateEntry{count: 1, resetAt: now.Add(pluginProxyRateWindow)}
		return true
	}
	if e.count >= limit {
		return false
	}
	e.count++
	rateBy[key] = e
	return true
}

func pluginProxyAllow(ip string) bool {
	return rateAllow("pp:"+ip, pluginProxyRateLimit)
}

func clientIP(r *http.Request) string {
	// Behind traefik the socket peer is traefik. Trust the LAST hop of
	// X-Forwarded-For: traefik overwrites the header today, but if any
	// front hop ever appends instead, the first entry is client-supplied
	// and taking it would make every per-IP limit spoofable.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

var secretPlaceholderRe = regexp.MustCompile(`\{\{secret:([A-Za-z0-9_-]+)\}\}`)

func pluginProxyHosts() map[string]bool {
	out := map[string]bool{}
	for _, h := range strings.Split(os.Getenv("PLUGIN_PROXY_HOSTS"), ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			out[h] = true
		}
	}
	return out
}

type pluginSecret struct {
	value string
	// Host this secret may be sent to. Empty = any allowlisted host, which
	// is safe with ONE host and a leak with two: any allowlisted upstream
	// could be handed every unbound secret. Bind with NAME@host=value.
	host string
}

var unboundSecretWarn sync.Once

func pluginProxySecrets() map[string]pluginSecret {
	out := map[string]pluginSecret{}
	var unbound []string
	for _, pair := range strings.Split(os.Getenv("PLUGIN_PROXY_SECRETS"), ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		if !ok || k == "" {
			continue
		}
		name, host, bound := strings.Cut(strings.TrimSpace(k), "@")
		name = strings.ToUpper(strings.TrimSpace(name))
		sec := pluginSecret{value: v}
		if bound {
			sec.host = strings.ToLower(strings.TrimSpace(host))
		} else {
			unbound = append(unbound, name)
		}
		out[name] = sec
	}
	if len(unbound) > 0 {
		unboundSecretWarn.Do(func() {
			log.Printf("[plugin-proxy] secrets without a host binding (%s) can be sent to ANY allowlisted host; prefer NAME@host=value", strings.Join(unbound, ", "))
		})
	}
	return out
}

// substituteSecrets replaces {{secret:NAME}} placeholders for a request
// bound for targetHost. A secret bound to a different host counts as
// missing: the caller answers 204 and no upstream ever sees a key that was
// not meant for it. Placeholders belong in query strings (values are
// query-escaped).
func substituteSecrets(raw string, secrets map[string]pluginSecret, targetHost string) (string, error) {
	targetHost = strings.ToLower(targetHost)
	var missing string
	replaced := secretPlaceholderRe.ReplaceAllStringFunc(raw, func(m string) string {
		name := strings.ToUpper(secretPlaceholderRe.FindStringSubmatch(m)[1])
		if sec, ok := secrets[name]; ok && (sec.host == "" || sec.host == targetHost) {
			return url.QueryEscape(sec.value)
		}
		if missing == "" {
			missing = name
		}
		return m
	})
	if missing != "" {
		return "", fmt.Errorf("secret %s not configured for %s", missing, targetHost)
	}
	return replaced, nil
}

func pluginProxyClient(allowed map[string]bool) *http.Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, fmt.Errorf("invalid address: %w", err)
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("lookup failed for %s", host)
			}
			for _, ipAddr := range ips {
				if isDisallowedIP(ipAddr.IP) {
					return nil, fmt.Errorf("disallowed IP: %s", ipAddr.IP)
				}
			}
			d := &net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}
	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			if req.URL.Scheme != "https" || !allowed[strings.ToLower(req.URL.Hostname())] {
				return fmt.Errorf("redirect outside the allowlist: %s", req.URL.Host)
			}
			return nil
		},
	}
}

func handlePluginProxy(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	allowed := pluginProxyHosts()
	if len(allowed) == 0 {
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	if !pluginProxyAllow(clientIP(r)) {
		apiError(w, r, "Slow down", http.StatusTooManyRequests)
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		apiError(w, r, "Missing url parameter", http.StatusBadRequest)
		return
	}
	// Parse BEFORE substitution: the target host decides which secrets may
	// be filled, so it has to come from the placeholder form of the url.
	pre, err := url.Parse(raw)
	if err != nil || pre.Scheme != "https" {
		apiError(w, r, "Only https urls", http.StatusBadRequest)
		return
	}
	host := strings.ToLower(pre.Hostname())
	if !allowed[host] {
		apiError(w, r, "Host not allowlisted on this instance", http.StatusForbidden)
		return
	}
	substituted, err := substituteSecrets(raw, pluginProxySecrets(), host)
	if err != nil {
		// Unconfigured or host-mismatched secret = "not set up".
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	target, err := url.Parse(substituted)
	if err != nil || target.Scheme != "https" ||
		strings.ToLower(target.Hostname()) != host {
		// Substitution must never move the request to another host.
		apiError(w, r, "Bad url", http.StatusBadRequest)
		return
	}

	// Cache key includes secrets, deliberately: it lives only in this
	// process's memory and distinct keys must not share entries.
	cacheKey := "pp:" + substituted
	if entry, ok := pluginProxyCached(cacheKey); ok {
		withCors(w, r, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", entry.contentType)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Write(entry.body)
		})
		return
	}

	resp, err := pluginProxyClient(allowed).Get(substituted)
	if err != nil {
		apiError(w, r, "Upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiError(w, r, fmt.Sprintf("Upstream answered %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, pluginProxyMaxBody+1))
	if err != nil || len(body) > pluginProxyMaxBody {
		apiError(w, r, "Upstream response too large", http.StatusBadGateway)
		return
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	pluginProxyStore(cacheKey, body, contentType)
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Write(body)
	})
}
