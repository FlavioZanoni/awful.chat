package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTurnCredentials_NoSecretFallsBack(t *testing.T) {
	t.Setenv("TURN_SECRET", "")
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 when TURN_SECRET unset, got %d", rec.Code)
	}
}

func TestTurnCredentials_HMACIsValid(t *testing.T) {
	const secret = "test-secret-123"
	t.Setenv("TURN_SECRET", secret)
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body struct {
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
		TTL        int      `json:"ttl"`
		URLs       []string `json:"urls"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if body.Username == "" || body.Credential == "" || len(body.URLs) == 0 {
		t.Fatalf("incomplete response: %+v", body)
	}
	// The credential must be HMAC-SHA1(secret, username), base64-encoded —
	// exactly what coturn recomputes to authenticate.
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(body.Username))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if body.Credential != want {
		t.Fatalf("credential HMAC mismatch: got %q want %q", body.Credential, want)
	}
}

func TestTurnCredentials_CustomURLs(t *testing.T) {
	t.Setenv("TURN_SECRET", "s")
	t.Setenv("TURN_URLS", "turn:a.example:3478 , , turn:b.example:5349")
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)

	var body struct {
		URLs []string `json:"urls"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.URLs) != 2 || body.URLs[0] != "turn:a.example:3478" || body.URLs[1] != "turn:b.example:5349" {
		t.Fatalf("TURN_URLS not parsed/trimmed correctly: %#v", body.URLs)
	}
}
