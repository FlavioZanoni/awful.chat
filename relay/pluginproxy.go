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
	body    []byte
	expires time.Time
}

func pluginProxyCached(key string) ([]byte, bool) {
	if v, ok := pluginProxyCache.Load(key); ok {
		e := v.(pluginProxyCacheEntry)
		if time.Now().Before(e.expires) {
			return e.body, true
		}
		pluginProxyCache.Delete(key)
	}
	return nil, false
}

func pluginProxyStore(key string, body []byte) {
	pluginProxyCache.Store(key, pluginProxyCacheEntry{body: body, expires: time.Now().Add(pluginProxyCacheTTL)})
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

func pluginProxySecrets() map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(os.Getenv("PLUGIN_PROXY_SECRETS"), ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		if ok && k != "" {
			out[strings.ToUpper(strings.TrimSpace(k))] = v
		}
	}
	return out
}

// substituteSecrets replaces {{secret:NAME}} placeholders. Returns an error
// naming the first missing secret so the client can say "instance not
// configured for this plugin" instead of guessing.
func substituteSecrets(raw string, secrets map[string]string) (string, error) {
	var missing string
	replaced := secretPlaceholderRe.ReplaceAllStringFunc(raw, func(m string) string {
		name := strings.ToUpper(secretPlaceholderRe.FindStringSubmatch(m)[1])
		if v, ok := secrets[name]; ok {
			return url.QueryEscape(v)
		}
		if missing == "" {
			missing = name
		}
		return m
	})
	if missing != "" {
		return "", fmt.Errorf("secret %s not configured", missing)
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
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		apiError(w, r, "Missing url parameter", http.StatusBadRequest)
		return
	}
	substituted, err := substituteSecrets(raw, pluginProxySecrets())
	if err != nil {
		// Unconfigured secret = the same "not set up" answer as no allowlist.
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	target, err := url.Parse(substituted)
	if err != nil || target.Scheme != "https" {
		apiError(w, r, "Only https urls", http.StatusBadRequest)
		return
	}
	if !allowed[strings.ToLower(target.Hostname())] {
		apiError(w, r, "Host not allowlisted on this instance", http.StatusForbidden)
		return
	}

	// Cache key includes secrets, deliberately: it lives only in this
	// process's memory and distinct keys must not share entries.
	cacheKey := "pp:" + substituted
	if body, ok := pluginProxyCached(cacheKey); ok {
		withCors(w, r, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.Write(body)
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
	pluginProxyStore(cacheKey, body)
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", contentType)
		w.Write(body)
	})
}
