package main

// Steam proxy for the steam-roulette plugin. Browsers cannot call Steam
// directly (no CORS on api.steampowered.com), so the relay fronts two
// endpoints the same way it fronts /og and /klipy. Gated by STEAM_API_KEY:
// unset returns 204 and the plugin tells the user the instance has no key.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var steamIDRe = regexp.MustCompile(`^[0-9]{17}$`)
var steamVanityRe = regexp.MustCompile(`^[A-Za-z0-9_-]{2,64}$`)

// parseSteamQuery accepts a steamid64, a vanity name, or a full profile url
// (either https://steamcommunity.com/profiles/<id64> or /id/<vanity>).
// Returns (steamID, vanity): exactly one is non-empty on success.
func parseSteamQuery(q string) (string, string) {
	q = strings.TrimSpace(q)
	if u, err := url.Parse(q); err == nil && u.Host != "" {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) >= 2 {
			switch parts[0] {
			case "profiles":
				if steamIDRe.MatchString(parts[1]) {
					return parts[1], ""
				}
			case "id":
				if steamVanityRe.MatchString(parts[1]) {
					return "", parts[1]
				}
			}
		}
		return "", ""
	}
	if steamIDRe.MatchString(q) {
		return q, ""
	}
	if steamVanityRe.MatchString(q) {
		return "", q
	}
	return "", ""
}

type steamGame struct {
	AppID uint64 `json:"appid"`
	Name  string `json:"name"`
}

// Small cache: libraries change slowly, Steam rate limits are real, and a
// room of people all resolving the same friend should cost one upstream call.
var steamCache sync.Map // key string -> steamCacheEntry

type steamCacheEntry struct {
	body    []byte
	expires time.Time
}

func steamCached(key string) ([]byte, bool) {
	if v, ok := steamCache.Load(key); ok {
		e := v.(steamCacheEntry)
		if time.Now().Before(e.expires) {
			return e.body, true
		}
		steamCache.Delete(key)
	}
	return nil, false
}

func steamStore(key string, body []byte) {
	steamCache.Store(key, steamCacheEntry{body: body, expires: time.Now().Add(10 * time.Minute)})
}

var steamHTTP = &http.Client{Timeout: 10 * time.Second}

func steamAPIKey() string { return os.Getenv("STEAM_API_KEY") }

func handleSteamResolve(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	key := steamAPIKey()
	if key == "" {
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	steamID, vanity := parseSteamQuery(r.URL.Query().Get("q"))
	if steamID == "" && vanity == "" {
		apiError(w, r, "Unrecognized steam profile", http.StatusBadRequest)
		return
	}
	if steamID == "" {
		cacheKey := "resolve:" + vanity
		if body, ok := steamCached(cacheKey); ok {
			steamID = string(body)
		} else {
			resp, err := steamHTTP.Get("https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=" +
				url.QueryEscape(key) + "&vanityurl=" + url.QueryEscape(vanity))
			if err != nil {
				apiError(w, r, "Steam unreachable", http.StatusBadGateway)
				return
			}
			defer resp.Body.Close()
			var parsed struct {
				Response struct {
					Success int    `json:"success"`
					SteamID string `json:"steamid"`
				} `json:"response"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil || parsed.Response.Success != 1 {
				apiError(w, r, "Steam profile not found", http.StatusNotFound)
				return
			}
			steamID = parsed.Response.SteamID
			steamStore(cacheKey, []byte(steamID))
		}
	}
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"steamId": steamID})
	})
}

func handleSteamGames(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	key := steamAPIKey()
	if key == "" {
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	steamID := r.URL.Query().Get("steamid")
	if !steamIDRe.MatchString(steamID) {
		apiError(w, r, "Bad steamid", http.StatusBadRequest)
		return
	}
	cacheKey := "games:" + steamID
	body, ok := steamCached(cacheKey)
	if !ok {
		resp, err := steamHTTP.Get("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?include_appinfo=1&include_played_free_games=1&key=" +
			url.QueryEscape(key) + "&steamid=" + url.QueryEscape(steamID))
		if err != nil {
			apiError(w, r, "Steam unreachable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		var parsed struct {
			Response struct {
				Games []steamGame `json:"games"`
			} `json:"response"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			apiError(w, r, "Steam answered garbage", http.StatusBadGateway)
			return
		}
		// An empty list usually means a private profile; say so, the plugin
		// can tell the user what to change.
		out := map[string]any{
			"games":   parsed.Response.Games,
			"private": len(parsed.Response.Games) == 0,
		}
		body, _ = json.Marshal(out)
		steamStore(cacheKey, body)
	}
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	})
}
