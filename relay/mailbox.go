package main

// Offline DM mailbox: store-and-forward for end-to-end encrypted blobs.
//
// The relay NEVER sees plaintext or sender identity. A sender seals the DM
// envelope to the recipient's key client-side (ephemeral-static ECDH, so no
// prior handshake and nothing in the blob names the sender) and deposits it
// under the recipient's mailbox id = SHA-256(recipient did). The recipient
// collects by proving control of the did with an ed25519 signature over a
// fresh timestamp, then acks; acked blobs are deleted immediately and
// unclaimed ones expire after MailboxTTL.
//
// What the relay learns: recipient mailbox, deposit times, padded sizes,
// depositor IP. What it cannot learn: content, sender identity.
//
// Kept deliberately small: DMs only, text-scale blobs (files ride WebTorrent
// peer-to-peer and are never deposited), hard caps everywhere.

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mr-tron/base58"
)

const (
	// One sealed text DM is a few hundred bytes; 16 KiB leaves room for
	// padding buckets and replies-with-context while keeping the server
	// footprint minimal. Anything bigger retries peer-to-peer instead.
	mailboxMaxBlob = 16 * 1024
	// Per-mailbox caps: count and total bytes.
	mailboxMaxMsgs  = 100
	mailboxMaxBytes = 512 * 1024
	// Unclaimed blobs expire; the P2P offline queue still retries forever,
	// so expiry only delays delivery until both sides co-online.
	mailboxTTL = 48 * time.Hour
	// Signed-timestamp freshness window for collect/ack.
	mailboxAuthSkew = 2 * time.Minute
	// Hard ceiling on everything under mailboxDir combined. Per-IP limits
	// mean nothing to a distributed depositor; without a global cap the
	// shared data volume could be filled without bound.
	mailboxGlobalMaxBytes = 256 << 20
	// Deposit/collect/ack per-IP budgets. Deposits get their own bucket so a
	// chatty plugin proxying data does not starve offline DMs (and vice
	// versa); collect+ack were previously unlimited, a free CPU/verify sink.
	mailboxDepositLimit = 10
	mailboxAuthedLimit  = 30
)

var mailboxDir = func() string {
	if d := os.Getenv("MAILBOX_DIR"); d != "" {
		return d
	}
	return "/app/data/mailbox"
}()

var mailboxBoxRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
var mailboxIDRe = regexp.MustCompile(`^[0-9a-f]{1,32}$`)

// mailboxMu serializes writes per process - deposit volume is tiny and a
// single lock keeps the quota check race-free.
var mailboxMu sync.Mutex

// didToPubKey decodes a did:key to the raw ed25519 public key. The app's
// identity layer encodes WITHOUT the multibase 'z' (did:key:<base58> of
// 0xed01||pub) - requiring the spec's z-form made every real client's
// collect/ack fail 401. Accept both, disambiguating by decode: 'z' is a
// valid base58 character, so only a successful 34-byte 0xed01 decode says
// which form this is.
func didToPubKey(did string) (ed25519.PublicKey, error) {
	const prefix = "did:key:"
	if !strings.HasPrefix(did, prefix) {
		return nil, fmt.Errorf("not a did:key")
	}
	body := did[len(prefix):]
	for _, s := range []string{body, strings.TrimPrefix(body, "z")} {
		raw, err := base58.Decode(s)
		if err == nil && len(raw) == 34 && raw[0] == 0xed && raw[1] == 0x01 {
			return ed25519.PublicKey(raw[2:]), nil
		}
	}
	return nil, fmt.Errorf("not an ed25519 did:key")
}

func mailboxIDForDid(did string) string {
	sum := sha256.Sum256([]byte(did))
	return hex.EncodeToString(sum[:])
}

// verifyMailboxAuth checks the collect/ack proof: an ed25519 signature by
// the did's key over "awful-mailbox:{unix-seconds}", fresh within the skew.
func verifyMailboxAuth(did string, ts int64, sigB64 string) (string, error) {
	if d := time.Since(time.Unix(ts, 0)); d > mailboxAuthSkew || d < -mailboxAuthSkew {
		return "", fmt.Errorf("stale timestamp")
	}
	pub, err := didToPubKey(did)
	if err != nil {
		return "", err
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return "", err
	}
	msg := []byte("awful-mailbox:" + strconv.FormatInt(ts, 10))
	if !ed25519.Verify(pub, msg, sig) {
		return "", fmt.Errorf("bad signature")
	}
	return mailboxIDForDid(did), nil
}

func mailboxCORS(w http.ResponseWriter, r *http.Request) bool {
	h := corsHeaders(r)
	h.Set("Access-Control-Allow-Methods", "POST,OPTIONS")
	for k, v := range h {
		w.Header()[k] = v
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return false
	}
	return true
}

type mailboxEntry struct {
	ID   string `json:"id"`
	Blob string `json:"blob"` // base64
	Ts   int64  `json:"ts"`   // deposit unix seconds
}

func boxPath(box string) string { return filepath.Join(mailboxDir, box) }

// mailboxUsedBytes tracks the global quota incrementally: a full-tree walk
// per deposit was tens of thousands of syscalls under mailboxMu at scale,
// serializing every deposit and ack behind disk I/O. One walk at startup
// (mailboxInitUsedBytes, before the sweeper loop), then deposits add and
// removals subtract. Guarded by mailboxMu like everything else here.
var mailboxUsedBytes int64

func mailboxInitUsedBytes() {
	mailboxMu.Lock()
	defer mailboxMu.Unlock()
	mailboxUsedBytes = 0
	boxes, _ := os.ReadDir(mailboxDir)
	for _, b := range boxes {
		entries, _ := os.ReadDir(filepath.Join(mailboxDir, b.Name()))
		for _, e := range entries {
			if info, err := e.Info(); err == nil {
				mailboxUsedBytes += info.Size()
			}
		}
	}
}

// handleMailboxDeposit stores one sealed blob. Anonymous by design; only
// rate limits and caps stand between it and abuse.
func handleMailboxDeposit(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllow("mb:"+clientIP(r), mailboxDepositLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Box  string `json:"box"`
		Blob string `json:"blob"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, mailboxMaxBlob*2)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !mailboxBoxRe.MatchString(req.Box) {
		http.Error(w, "bad mailbox", http.StatusBadRequest)
		return
	}
	blob, err := base64.StdEncoding.DecodeString(req.Blob)
	if err != nil || len(blob) == 0 || len(blob) > mailboxMaxBlob {
		http.Error(w, "bad blob", http.StatusBadRequest)
		return
	}

	mailboxMu.Lock()
	defer mailboxMu.Unlock()
	dir := boxPath(req.Box)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	entries, _ := os.ReadDir(dir)
	var total int64
	for _, e := range entries {
		if info, err := e.Info(); err == nil {
			total += info.Size()
		}
	}
	if len(entries) >= mailboxMaxMsgs || total+int64(len(blob)) > mailboxMaxBytes {
		http.Error(w, "mailbox full", http.StatusInsufficientStorage)
		return
	}
	if mailboxUsedBytes+int64(len(blob)) > mailboxGlobalMaxBytes {
		http.Error(w, "mailbox full", http.StatusInsufficientStorage)
		return
	}
	id := strconv.FormatInt(time.Now().UnixNano(), 16)
	if err := os.WriteFile(filepath.Join(dir, id), blob, 0o600); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	mailboxUsedBytes += int64(len(blob))
	w.WriteHeader(http.StatusNoContent)
}

// handleMailboxCollect returns every pending blob for the proven did.
func handleMailboxCollect(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	// Unlimited, these endpoints were a free signature-verification and
	// ReadDir sink for anyone with curl. 30/min covers the 5-minute collect
	// loop plus its acks many times over.
	if !rateAllow("mba:"+clientIP(r), mailboxAuthedLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did string `json:"did"`
		Ts  int64  `json:"ts"`
		Sig string `json:"sig"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	box, err := verifyMailboxAuth(req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	entries, _ := os.ReadDir(boxPath(box))
	out := []mailboxEntry{}
	for _, e := range entries {
		if !mailboxIDRe.MatchString(e.Name()) {
			continue
		}
		blob, err := os.ReadFile(filepath.Join(boxPath(box), e.Name()))
		if err != nil {
			continue
		}
		ts := int64(0)
		if info, err := e.Info(); err == nil {
			ts = info.ModTime().Unix()
		}
		out = append(out, mailboxEntry{
			ID:   e.Name(),
			Blob: base64.StdEncoding.EncodeToString(blob),
			Ts:   ts,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handleMailboxAck deletes collected blobs for the proven did.
func handleMailboxAck(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllow("mba:"+clientIP(r), mailboxAuthedLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did string   `json:"did"`
		Ts  int64    `json:"ts"`
		Sig string   `json:"sig"`
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	box, err := verifyMailboxAuth(req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Under mailboxMu: the empty-directory Remove racing a concurrent
	// deposit's ReadDir->WriteFile window turned that deposit into a
	// spurious 500 (WriteFile into a just-removed directory).
	mailboxMu.Lock()
	for _, id := range req.IDs {
		if mailboxIDRe.MatchString(id) {
			p := filepath.Join(boxPath(box), id)
			if info, err := os.Stat(p); err == nil && os.Remove(p) == nil {
				mailboxUsedBytes -= info.Size()
			}
		}
	}
	_ = os.Remove(boxPath(box)) // succeeds only when empty
	mailboxMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// startMailboxSweeper expires unclaimed blobs. Runs hourly; a restart
// changes nothing because the state is plain files under the data volume.
func startMailboxSweeper() {
	mailboxInitUsedBytes()
	go func() {
		for {
			cutoff := time.Now().Add(-mailboxTTL)
			boxes, _ := os.ReadDir(mailboxDir)
			removed := 0
			for _, b := range boxes {
				dir := filepath.Join(mailboxDir, b.Name())
				// Same deposit-vs-remove race as ack: the empty-dir Remove
				// must not land inside a deposit's quota-check window.
				mailboxMu.Lock()
				entries, _ := os.ReadDir(dir)
				for _, e := range entries {
					if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
						if os.Remove(filepath.Join(dir, e.Name())) == nil {
							mailboxUsedBytes -= info.Size()
						}
						removed++
					}
				}
				_ = os.Remove(dir) // only if empty
				mailboxMu.Unlock()
			}
			if removed > 0 {
				log.Printf("[mailbox] expired %d blob(s)", removed)
			}
			time.Sleep(time.Hour)
		}
	}()
}
