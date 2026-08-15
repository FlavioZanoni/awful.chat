package main

import (
	"encoding/json"
	"testing"
	"time"
)

// fakeStream implements rvStream, capturing frames written by the registry.
type fakeStream struct {
	frames [][]byte
}

func (f *fakeStream) Write(p []byte) (int, error) {
	buf := make([]byte, len(p))
	copy(buf, p)
	f.frames = append(f.frames, buf)
	return len(p), nil
}

func (f *fakeStream) SetWriteDeadline(time.Time) error { return nil }

// decode strips the 4-byte big-endian length prefix and unmarshals the JSON.
func (f *fakeStream) decode(t *testing.T, i int) serverMsg {
	t.Helper()
	frame := f.frames[i]
	if len(frame) < 4 {
		t.Fatalf("frame %d too short: %d bytes", i, len(frame))
	}
	msgLen := int(frame[0])<<24 | int(frame[1])<<16 | int(frame[2])<<8 | int(frame[3])
	if msgLen != len(frame)-4 {
		t.Fatalf("frame %d length prefix %d != payload %d", i, msgLen, len(frame)-4)
	}
	var msg serverMsg
	if err := json.Unmarshal(frame[4:], &msg); err != nil {
		t.Fatalf("frame %d bad json: %v", i, err)
	}
	return msg
}

func newClient(r *registry, peerId string) (*connectedClient, *fakeStream) {
	s := &fakeStream{}
	r.mu.Lock()
	r.nextGeneration++
	c := &connectedClient{peerId: peerId, stream: s, rooms: make(map[string]struct{}), generation: r.nextGeneration}
	r.clients[peerId] = c
	r.mu.Unlock()
	return c, s
}

func TestRegisterSendsPeerListAndNotifies(t *testing.T) {
	r := newRegistry()
	a, sa := newClient(r, "peer-a")
	b, sb := newClient(r, "peer-b")

	r.register(a, "room1")
	// Joiner with empty room gets an empty PEERS list
	msg := sa.decode(t, 0)
	if msg.Type != "PEERS" || msg.Room != "room1" || len(msg.Peers) != 0 {
		t.Fatalf("unexpected first PEERS msg: %+v", msg)
	}

	r.register(b, "room1")
	// Existing peer A gets PEER_JOINED
	joined := sa.decode(t, 1)
	if joined.Type != "PEER_JOINED" || joined.Peer != "peer-b" {
		t.Fatalf("expected PEER_JOINED for b, got %+v", joined)
	}
	// Joiner B gets the peer list containing A
	peers := sb.decode(t, 0)
	if peers.Type != "PEERS" || len(peers.Peers) != 1 || peers.Peers[0] != "peer-a" {
		t.Fatalf("expected PEERS [peer-a], got %+v", peers)
	}
}

func TestRegisterIsIdempotent(t *testing.T) {
	r := newRegistry()
	a, sa := newClient(r, "peer-a")
	r.register(a, "room1")
	r.register(a, "room1")
	if len(sa.frames) != 1 {
		t.Fatalf("duplicate register should not resend PEERS, got %d frames", len(sa.frames))
	}
	if len(r.rooms["room1"]) != 1 {
		t.Fatalf("room should have 1 peer, got %d", len(r.rooms["room1"]))
	}
}

func TestUnregisterNotifiesAndCleansEmptyRoom(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "peer-a")
	b, sb := newClient(r, "peer-b")
	r.register(a, "room1")
	r.register(b, "room1")

	before := len(sb.frames)
	r.unregister(a, "room1")

	left := sb.decode(t, before)
	if left.Type != "PEER_LEFT" || left.Peer != "peer-a" {
		t.Fatalf("expected PEER_LEFT peer-a, got %+v", left)
	}

	r.unregister(b, "room1")
	if _, exists := r.rooms["room1"]; exists {
		t.Fatal("empty room should be deleted")
	}
}

func TestDisconnectRemovesFromAllRooms(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "peer-a")
	b, sb := newClient(r, "peer-b")
	r.register(a, "room1")
	r.register(a, "room2")
	r.register(b, "room1")

	before := len(sb.frames)
	r.disconnect("peer-a", 0) // generation 0 for backup disconnect (always proceeds)

	if _, ok := r.clients["peer-a"]; ok {
		t.Fatal("client should be removed on disconnect")
	}
	if _, ok := r.rooms["room1"]["peer-a"]; ok {
		t.Fatal("peer should be out of room1")
	}
	if _, ok := r.rooms["room2"]; ok {
		t.Fatal("room2 should be deleted (was only member)")
	}
	left := sb.decode(t, before)
	if left.Type != "PEER_LEFT" || left.Peer != "peer-a" {
		t.Fatalf("expected PEER_LEFT broadcast, got %+v", left)
	}
}

func TestDisconnectUnknownPeerIsNoop(t *testing.T) {
	r := newRegistry()
	r.disconnect("ghost", 0) // must not panic
}
