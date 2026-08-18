package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2ptls "github.com/libp2p/go-libp2p/p2p/security/tls"
	"github.com/libp2p/go-libp2p/p2p/transport/websocket"
)

const RendezvousProtocol = "/awful/rendezvous/1.0.0"

type clientMsg struct {
	Type string `json:"type"` // REGISTER | UNREGISTER
	Room string `json:"room"`
}

type serverMsg struct {
	Type  string   `json:"type"` // PEERS | PEER_JOINED | PEER_LEFT
	Room  string   `json:"room"`
	Peers []string `json:"peers"`
	Peer  string   `json:"peer,omitempty"` // PEER_JOINED | PEER_LEFT
}

// rvStream is the slice of network.Stream the registry needs - an
// interface so tests can stub it without a real libp2p stream.
type rvStream interface {
	io.Writer
	SetWriteDeadline(time.Time) error
}

type connectedClient struct {
	peerId     string
	stream     rvStream
	rooms      map[string]struct{}
	generation uint64 // Incremented on each new connection; used to avoid evicting reconnected sessions
}

type registry struct {
	mu             sync.Mutex
	rooms          map[string]map[string]struct{} // room → set of peerIds
	clients        map[string]*connectedClient    // peerId → client
	nextGeneration uint64                         // Incremented for each new client connection
}

func newRegistry() *registry {
	return &registry{
		rooms:   make(map[string]map[string]struct{}),
		clients: make(map[string]*connectedClient),
	}
}

func (r *registry) sendTo(c *connectedClient, msg serverMsg) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// 4-byte big-endian length prefix to match the JS client framing
	frame := make([]byte, 4+len(data))
	frame[0] = byte(len(data) >> 24)
	frame[1] = byte(len(data) >> 16)
	frame[2] = byte(len(data) >> 8)
	frame[3] = byte(len(data))
	copy(frame[4:], data)
	c.stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	c.stream.Write(frame)
}

func (r *registry) register(c *connectedClient, room string) {
	r.mu.Lock()

	if r.rooms[room] == nil {
		r.rooms[room] = make(map[string]struct{})
	}
	if _, already := r.rooms[room][c.peerId]; already {
		r.mu.Unlock()
		return
	}

	r.rooms[room][c.peerId] = struct{}{}
	c.rooms[room] = struct{}{}

	log.Printf("[rv] %s joined room [%s] (%d peers)", short(c.peerId), room, len(r.rooms[room]))

	// Snapshot clients to notify and peer list under lock, then release lock before sending
	peers := r.rooms[room]
	targetClients := make([]*connectedClient, 0, len(peers))
	for pid := range peers {
		if pid == c.peerId {
			continue
		}
		if cl, ok := r.clients[pid]; ok {
			targetClients = append(targetClients, cl)
		}
	}

	others := make([]string, 0)
	for pid := range r.rooms[room] {
		if pid != c.peerId {
			others = append(others, pid)
		}
	}

	r.mu.Unlock()

	// Send notifications outside the lock
	for _, tc := range targetClients {
		r.sendTo(tc, serverMsg{
			Type: "PEER_JOINED",
			Room: room,
			Peer: c.peerId,
		})
	}
	r.sendTo(c, serverMsg{Type: "PEERS", Room: room, Peers: others})
}

func (r *registry) unregister(c *connectedClient, room string) {
	r.mu.Lock()
	targets := r.doUnregister(c, room)
	r.mu.Unlock()

	// Send notifications outside the lock
	for _, tc := range targets {
		r.sendTo(tc, serverMsg{
			Type: "PEER_LEFT",
			Room: room,
			Peer: c.peerId,
		})
	}
}

// caller must hold r.mu
// returns the list of clients to notify about the departure
func (r *registry) doUnregister(c *connectedClient, room string) []*connectedClient {
	peers := r.rooms[room]
	if peers == nil {
		return nil
	}
	delete(peers, c.peerId)
	delete(c.rooms, room)

	log.Printf("[rv] %s left room [%s] (%d peers)", short(c.peerId), room, len(peers))

	if len(peers) == 0 {
		delete(r.rooms, room)
		return nil
	}

	// Snapshot clients to notify
	targets := make([]*connectedClient, 0, len(peers))
	for pid := range peers {
		if cl, ok := r.clients[pid]; ok {
			targets = append(targets, cl)
		}
	}
	return targets
}

func (r *registry) disconnect(peerId string, generation uint64) {
	r.mu.Lock()

	c, ok := r.clients[peerId]
	if !ok {
		r.mu.Unlock()
		return
	}

	// Only delete if this is still the same client instance (generation matches).
	// This prevents a stale read-loop from evicting a freshly reconnected session.
	// generation == 0 is used for backup disconnects (DisconnectedF) and always proceeds.
	if generation != 0 && c.generation != generation {
		r.mu.Unlock()
		return
	}

	// Collect all notifications by room while holding the lock
	type notification struct {
		room   string
		client *connectedClient
	}
	var notifications []notification
	for room := range c.rooms {
		targets := r.doUnregister(c, room)
		for _, tc := range targets {
			notifications = append(notifications, notification{room, tc})
		}
	}
	delete(r.clients, peerId)
	log.Printf("[rv] %s disconnected", short(peerId))

	r.mu.Unlock()

	// Send notifications outside the lock
	for _, n := range notifications {
		r.sendTo(n.client, serverMsg{
			Type: "PEER_LEFT",
			Room: n.room,
			Peer: peerId,
		})
	}
}

// ── Stream handler ────────────────────────────────────────────────────────────

func (r *registry) handleStream(s network.Stream) {
	peerId := s.Conn().RemotePeer().String()
	log.Printf("[rv] %s opened rendezvous stream", short(peerId))

	r.mu.Lock()
	// clean up any stale entry from a previous connection
	if old, ok := r.clients[peerId]; ok {
		for room := range old.rooms {
			r.doUnregister(old, room)
		}
	}
	r.nextGeneration++
	c := &connectedClient{
		peerId:     peerId,
		stream:     s,
		rooms:      make(map[string]struct{}),
		generation: r.nextGeneration,
	}
	r.clients[peerId] = c
	r.mu.Unlock()

	// Read loop - reassemble length-prefixed frames
	const maxMsgLen = 8192 // Max size for a single frame (REGISTER/UNREGISTER payloads are tiny)
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 4096)

readLoop:
	for {
		n, err := s.Read(tmp)
		if err != nil {
			break
		}
		buf = append(buf, tmp[:n]...)

		for len(buf) >= 4 {
			msgLen := int(buf[0])<<24 | int(buf[1])<<16 | int(buf[2])<<8 | int(buf[3])
			// Reject oversized frames to prevent memory DoS. Abort the whole
			// stream - a plain `break` here would leave the bad length header in
			// buf and re-trip on every subsequent read while buf grows unbounded.
			if msgLen > maxMsgLen {
				log.Printf("[rv] message too large from %s: %d bytes, closing stream", short(peerId), msgLen)
				s.Reset()
				break readLoop
			}
			if len(buf) < 4+msgLen {
				break
			}
			payload := buf[4 : 4+msgLen]
			buf = buf[4+msgLen:]

			var msg clientMsg
			if err := json.Unmarshal(payload, &msg); err != nil {
				log.Printf("[rv] bad message from %s: %v", short(peerId), err)
				continue
			}

			switch msg.Type {
			case "REGISTER":
				r.register(c, msg.Room)
			case "UNREGISTER":
				r.unregister(c, msg.Room)
			default:
				log.Printf("[rv] unknown type from %s: %s", short(peerId), msg.Type)
			}
		}
	}

	log.Printf("[rv] %s stream closed", short(peerId))
	r.disconnect(peerId, c.generation)
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	flag.Parse()

	os.MkdirAll("/app/data", os.ModePerm)
	priv := loadOrGenKey("/app/data/relay.key")

	connMgr, _ := connmgr.NewConnManager(256, 512)

	// Get port from env or default to 8080
	httpPort := os.Getenv("HTTP_PORT")
	if httpPort == "" {
		httpPort = "8080"
	}

	// libp2p WebSocket
	h, err := libp2p.New(
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(fmt.Sprintf("/ip4/0.0.0.0/tcp/%s/ws", httpPort)),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Security(libp2ptls.ID, libp2ptls.New),
		libp2p.Muxer("/yamux/1.0.0", yamux.DefaultTransport),
		libp2p.Transport(websocket.New),
		libp2p.ConnectionManager(connMgr),
		libp2p.ForceReachabilityPublic(),
		libp2p.EnableRelay(),
		libp2p.EnableRelayService(relayv2.WithInfiniteLimits()),
		libp2p.EnableHolePunching(),
		libp2p.EnableNATService(),
	)
	if err != nil {
		log.Fatal(err)
	}

	reg := newRegistry()
	h.SetStreamHandler(RendezvousProtocol, reg.handleStream)

	// HTTP server for OG and Klipy endpoints (run on separate internal port)
	apiPort := "8081"
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/og", handleOgPreview)
		// the frontend fetches /og/preview (path inherited from the old signal server)
		mux.HandleFunc("/og/preview", handleOgPreview)
		mux.HandleFunc("/klipy/search", handleKlipySearch)
		mux.HandleFunc("/klipy/trending", handleKlipyTrending)
		mux.HandleFunc("/turn-credentials", handleTurnCredentials)
		log.Printf("[http] Starting API server on port %s", apiPort)
		server := &http.Server{
			Addr:              ":" + apiPort,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      15 * time.Second,
			IdleTimeout:       30 * time.Second,
		}
		if err := server.ListenAndServe(); err != nil {
			log.Printf("[http] API server error: %v", err)
		}
	}()

	// Clean up on libp2p disconnect (belt + suspenders with stream close)
	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(_ network.Network, c network.Conn) {
			// Deliberately NOT closing the peer's older connections here. Two
			// tabs of the app share one peerId (the device key lives in
			// localStorage), so "older connection from the same peer" cannot
			// be told apart from "the user's other tab" - closing it makes
			// live tabs kill each other's relay connection in a permanent
			// flap loop. Stale circuits from reloads are handled client-side
			// instead: streams are ping-confirmed before use and unanswered
			// connections are dropped there.
			log.Printf("[peer] connect %s", short(c.RemotePeer().String()))
		},
		DisconnectedF: func(n network.Network, c network.Conn) {
			peerId := c.RemotePeer()
			// A peer that reconnected on a fresh connection is still Connected -
			// don't let this old connection's teardown evict the new session.
			// Only clean up when the peer is genuinely gone. (handleStream's
			// stream-close path is the authoritative cleanup.)
			if n.Connectedness(peerId) == network.Connected {
				return
			}
			log.Printf("[peer] disconnect %s", short(peerId.String()))
			reg.disconnect(peerId.String(), 0)
		},
	})

	printAddrs(h)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	h.Close()
}

func short(peerId string) string {
	if len(peerId) > 8 {
		return peerId[len(peerId)-8:]
	}
	return peerId
}

func loadOrGenKey(path string) crypto.PrivKey {
	data, err := os.ReadFile(path)
	if err == nil {
		priv, err := crypto.UnmarshalPrivateKey(data)
		if err == nil {
			return priv
		}
	}

	priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	data, err = crypto.MarshalPrivateKey(priv)
	if err != nil {
		log.Fatal(err)
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		log.Fatal(err)
	}
	return priv
}

func printAddrs(h host.Host) {
	log.Printf("PeerID: %s", h.ID())
	for _, ma := range h.Addrs() {
		log.Printf(" %s/p2p/%s", ma, h.ID())
	}
}
