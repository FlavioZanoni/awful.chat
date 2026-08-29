import { afterEach, describe, expect, it, vi } from "vitest";

// sync.svelte.ts pulls in LibP2PTransport, whose WebRTC dependency chain
// needs a native binding (node-datachannel) this test environment doesn't
// build. The fake below records handlers and sent frames, and lets a test
// script send() results (a queued `false` models a stream that never
// confirmed), which is enough to drive the target-side handshake.
const { FakeTransport, instances } = vi.hoisted(() => {
  const instances: any[] = [];
  class FakeTransport {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    sent: { type: string; payload?: any }[] = [];
    sendResults: boolean[] = [];
    constructor() {
      instances.push(this);
    }
    on(event: string, fn: (...args: any[]) => void) {
      const arr = this.handlers.get(event) ?? [];
      arr.push(fn);
      this.handlers.set(event, arr);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    async connect() {}
    joinRoom() {}
    async disconnect() {}
    selfId() {
      return "";
    }
    async send(_peerId: string, data: Uint8Array) {
      this.sent.push(JSON.parse(new TextDecoder().decode(data)));
      return this.sendResults.length ? this.sendResults.shift()! : true;
    }
  }
  return { FakeTransport, instances };
});
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: FakeTransport }));

import {
  cancelSync,
  connectAsTarget,
  generateShortCode,
  matchesSourcePeer,
  parsePlaintextToken,
  parseShortCode,
  peerIdShortPrefix,
  syncState,
  utf8Length,
} from "./sync.svelte";

// A realistic-shaped Ed25519 libp2p peerId: the constant "12D3KooW" multihash
// prefix followed by base58 key material.
const PEER_ID = "12D3KooWBmoLnSw8ChzC2K1LZjb1XkUJDihMAcqBRfsTGjfCgHz";
const ROOM_CODE = "__sync_deadbeef";
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("peerIdShortPrefix", () => {
  it("takes the 8 chars right after the Ed25519 prefix", () => {
    expect(peerIdShortPrefix(PEER_ID)).toBe(PEER_ID.slice(8, 16));
    expect(peerIdShortPrefix(PEER_ID)).toBe("BmoLnSw8");
  });

  it("still returns chars [8,16) for a peerId without the expected prefix", () => {
    const oddPeerId = "notEd25519PrefixedPeerIdString";
    expect(peerIdShortPrefix(oddPeerId)).toBe(oddPeerId.slice(8, 16));
  });
});

describe("generateShortCode / parseShortCode round trip", () => {
  it("round-trips room, token and peer prefix through the 3-part short code", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    expect(code.split("-")).toHaveLength(3);

    const parsed = parseShortCode(code);
    expect(parsed).toEqual({
      roomCode: ROOM_CODE,
      token: TOKEN.slice(0, 8),
      peerPrefix: peerIdShortPrefix(PEER_ID),
    });
  });

  it("rejects a 2-part (pre-peerId-pinning) short code", () => {
    expect(parseShortCode("deadbeef-01234567")).toBeNull();
  });

  it("rejects segments of the wrong length", () => {
    expect(parseShortCode("short-01234567-BmoLnSw8")).toBeNull();
  });
});

describe("parsePlaintextToken", () => {
  it("accepts a well-formed 3-part short code and carries the peerPrefix", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    const payload = parsePlaintextToken(code);
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ROOM_CODE);
    expect(payload!.token).toBe(TOKEN.slice(0, 8));
    expect(payload!.peerPrefix).toBe(peerIdShortPrefix(PEER_ID));
    expect(payload!.peerId).toBeUndefined();
  });

  it("rejects the old 2-part short code with a clear update-both-devices error", () => {
    expect(() => parsePlaintextToken("deadbeef-01234567")).toThrow(
      /update both devices/i
    );
  });

  it("accepts the 3-part full (colon-delimited) format with a peerId", () => {
    const payload = parsePlaintextToken(`${ROOM_CODE}:${TOKEN}:${PEER_ID}`);
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ROOM_CODE);
    expect(payload!.token).toBe(TOKEN);
    expect(payload!.peerId).toBe(PEER_ID);
    expect(payload!.peerPrefix).toBeUndefined();
  });

  it("rejects the old 2-part full format (room:token, no peerId)", () => {
    expect(() => parsePlaintextToken(`${ROOM_CODE}:${TOKEN}`)).toThrow(
      /update both devices/i
    );
  });

  it("returns null for garbage input", () => {
    expect(parsePlaintextToken("not a sync code")).toBeNull();
    expect(parsePlaintextToken("")).toBeNull();
  });
});

describe("matchesSourcePeer", () => {
  it("matches on the full peerId when the payload carries one", () => {
    expect(matchesSourcePeer({ peerId: PEER_ID } as never, PEER_ID)).toBe(
      true
    );
    expect(
      matchesSourcePeer({ peerId: PEER_ID } as never, "someOtherPeerId12345")
    ).toBe(false);
  });

  it("matches on the peerPrefix when the payload only carries that", () => {
    const prefix = peerIdShortPrefix(PEER_ID);
    expect(matchesSourcePeer({ peerPrefix: prefix } as never, PEER_ID)).toBe(
      true
    );
    expect(
      matchesSourcePeer({ peerPrefix: "ZZZZZZZZ" } as never, PEER_ID)
    ).toBe(false);
  });

  it("refuses to match anything when the payload has neither", () => {
    expect(matchesSourcePeer({} as never, PEER_ID)).toBe(false);
  });
});

describe("utf8Length", () => {
  // Batches are sized against the transport's 4MB frame cap, and an
  // oversized frame is not a polite failure: the receiver aborts the whole
  // inbound stream and the rest of the transfer goes with it.
  const encoded = (v: string) => new TextEncoder().encode(v).length;

  it("matches TextEncoder for ASCII", () => {
    expect(utf8Length("hello")).toBe(encoded("hello"));
  });

  it("matches TextEncoder for accented text", () => {
    const v = "ação, café, jalapeño";
    expect(utf8Length(v)).toBe(encoded(v));
  });

  it("matches TextEncoder for CJK, where .length undercounts by three", () => {
    const v = "今日はいい天気ですね";
    expect(utf8Length(v)).toBe(encoded(v));
    expect(v.length).toBeLessThan(utf8Length(v));
  });

  it("counts an emoji surrogate pair as one four-byte character", () => {
    const v = "👋🏽 hi 🎉";
    expect(utf8Length(v)).toBe(encoded(v));
  });

  it("matches TextEncoder on a lone surrogate rather than swallowing what follows", () => {
    // Not valid UTF-16, but JSON.stringify of a corrupt record can produce
    // one. The character AFTER it must still be counted: a version that
    // assumed every high surrogate had a partner passed the ASCII case here
    // by coincidence and undercounted this one.
    for (const v of ["a\ud800b", "\ud800今", "\ud800", "\udc00x"]) {
      expect(utf8Length(v)).toBe(encoded(v));
    }
  });

  it("is zero for empty input", () => {
    expect(utf8Length("")).toBe(0);
  });
});

describe("target ExportRequest delivery", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cancelSync();
  });

  const payload = () => ({
    roomCode: ROOM_CODE,
    token: TOKEN,
    expires: Date.now() + 60_000,
    peerId: PEER_ID,
  });

  const requests = (t: any) =>
    t.sent.filter((m: any) => m.type === "sync_export_request");

  it("retries the ExportRequest when the first send never confirms", async () => {
    vi.useFakeTimers();
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.sendResults = [false, true];
    t.emit("connect", PEER_ID);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(requests(t)).toHaveLength(2);
    expect(syncState.syncError).toBeNull();
  });

  it("errors out instead of stalling at 0% when every send fails", async () => {
    vi.useFakeTimers();
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.sendResults = [false, false, false];
    t.emit("connect", PEER_ID);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(requests(t)).toHaveLength(3);
    expect(syncState.syncError).toMatch(/Could not send the sync request/);
    expect(syncState.isSyncing).toBe(false);
  });

  it("does not re-request on a reconnect while the first request stands", async () => {
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    t.emit("connect", PEER_ID);
    await Promise.resolve();
    expect(requests(t)).toHaveLength(1);
  });
});
