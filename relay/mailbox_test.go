package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

func testDid(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := append([]byte{0xed, 0x01}, pub...)
	return "did:key:z" + base58.Encode(raw), priv
}

func authFields(priv ed25519.PrivateKey) (int64, string) {
	ts := time.Now().Unix()
	sig := ed25519.Sign(priv, []byte("awful-mailbox:"+strconv.FormatInt(ts, 10)))
	return ts, base64.StdEncoding.EncodeToString(sig)
}

func TestMailboxRoundTrip(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	blob := []byte("sealed bytes here")

	// Deposit (anonymous).
	depositBody, _ := json.Marshal(map[string]string{
		"box":  box,
		"blob": base64.StdEncoding.EncodeToString(blob),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(depositBody))
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 204 {
		t.Fatalf("deposit: got %d %s", w.Code, w.Body.String())
	}

	// Collect with a valid signature.
	ts, sig := authFields(priv)
	collectBody, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(collectBody))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	if w.Code != 200 {
		t.Fatalf("collect: got %d %s", w.Code, w.Body.String())
	}
	var got []mailboxEntry
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	back, _ := base64.StdEncoding.DecodeString(got[0].Blob)
	if !bytes.Equal(back, blob) {
		t.Fatal("blob mismatch")
	}

	// Ack deletes it.
	ts, sig = authFields(priv)
	ackBody, _ := json.Marshal(map[string]any{
		"did": did, "ts": ts, "sig": sig, "ids": []string{got[0].ID},
	})
	req = httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(ackBody))
	w = httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 204 {
		t.Fatalf("ack: got %d", w.Code)
	}

	ts, sig = authFields(priv)
	collectBody, _ = json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(collectBody))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var after []mailboxEntry
	_ = json.Unmarshal(w.Body.Bytes(), &after)
	if len(after) != 0 {
		t.Fatalf("expected empty after ack, got %d", len(after))
	}
}

func TestMailboxRejectsBadAuthAndOversize(t *testing.T) {
	mailboxDir = t.TempDir()
	did, _ := testDid(t)
	_, otherPriv := func() (string, ed25519.PrivateKey) { return testDid(t) }()

	// Signature from a DIFFERENT key must not open the box.
	ts, sig := authFields(otherPriv)
	body, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req := httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMailboxCollect(w, req)
	if w.Code != 401 {
		t.Fatalf("wrong-key collect: got %d", w.Code)
	}

	// A stale timestamp is replayable evidence, not auth.
	stale := time.Now().Add(-10 * time.Minute).Unix()
	body, _ = json.Marshal(map[string]any{"did": did, "ts": stale, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	if w.Code != 401 {
		t.Fatalf("stale collect: got %d", w.Code)
	}

	// Oversized blobs are refused outright.
	big := make([]byte, mailboxMaxBlob+1)
	body, _ = json.Marshal(map[string]string{
		"box":  mailboxIDForDid(did),
		"blob": base64.StdEncoding.EncodeToString(big),
	})
	req = httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code == 204 {
		t.Fatal("oversize deposit accepted")
	}
}
