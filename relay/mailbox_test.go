package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

func TestMailboxCaps(t *testing.T) {
	mailboxDir = t.TempDir()
	did, _ := testDid(t)
	box := mailboxIDForDid(did)

	// The deposit limiter is per client IP; hand every request its own so
	// this test exercises the CAPS, not the limiter.
	n := 0
	deposit := func(blob []byte) int {
		n++
		body, _ := json.Marshal(map[string]string{
			"box":  box,
			"blob": base64.StdEncoding.EncodeToString(blob),
		})
		req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("10.9.%d.%d", n/250, n%250))
		w := httptest.NewRecorder()
		handleMailboxDeposit(w, req)
		return w.Code
	}

	// Byte cap: 512 KiB total. 15 KiB blobs hit it well before the count cap.
	blob := bytes.Repeat([]byte("x"), 15*1024)
	full := 0
	for i := 0; i < mailboxMaxMsgs+5; i++ {
		if code := deposit(blob); code == 507 {
			full = i
			break
		} else if code != 204 {
			t.Fatalf("deposit %d: got %d", i, code)
		}
	}
	if full == 0 || full > mailboxMaxBytes/(15*1024)+1 {
		t.Fatalf("byte cap never enforced or enforced late (at %d)", full)
	}

	// Count cap: tiny blobs must stop at mailboxMaxMsgs entries.
	mailboxDir = t.TempDir()
	for i := 0; i < mailboxMaxMsgs; i++ {
		if code := deposit([]byte("s")); code != 204 {
			t.Fatalf("small deposit %d: got %d", i, code)
		}
	}
	if code := deposit([]byte("s")); code != 507 {
		t.Fatalf("deposit past count cap: got %d, want 507", code)
	}

	// Malformed box ids never touch the filesystem.
	body, _ := json.Marshal(map[string]string{
		"box":  "../../etc",
		"blob": base64.StdEncoding.EncodeToString([]byte("x")),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 400 {
		t.Fatalf("traversal box id: got %d, want 400", w.Code)
	}
}

func TestMailboxAckScopedToOwnBox(t *testing.T) {
	mailboxDir = t.TempDir()
	didA, privA := testDid(t)
	didB, privB := testDid(t)

	// One blob in B's box.
	body, _ := json.Marshal(map[string]string{
		"box":  mailboxIDForDid(didB),
		"blob": base64.StdEncoding.EncodeToString([]byte("for B")),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	req.Header.Set("X-Forwarded-For", "10.8.0.1")
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 204 {
		t.Fatalf("deposit: got %d", w.Code)
	}

	// B learns the entry id.
	ts, sig := authFields(privB)
	body, _ = json.Marshal(map[string]any{"did": didB, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var got []mailboxEntry
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || len(got) != 1 {
		t.Fatalf("collect for B: %v %d", err, len(got))
	}

	// A acks that id (plus traversal attempts): B's blob must survive.
	ts, sig = authFields(privA)
	body, _ = json.Marshal(map[string]any{
		"did": didA, "ts": ts, "sig": sig,
		"ids": []string{got[0].ID, "../" + mailboxIDForDid(didB) + "/" + got[0].ID, "..", "."},
	})
	req = httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 204 {
		t.Fatalf("ack as A: got %d", w.Code)
	}

	ts, sig = authFields(privB)
	body, _ = json.Marshal(map[string]any{"did": didB, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var after []mailboxEntry
	_ = json.Unmarshal(w.Body.Bytes(), &after)
	if len(after) != 1 {
		t.Fatalf("A's ack removed B's blob: %d entries left", len(after))
	}
}
