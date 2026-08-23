import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibP2PVoice } from "./voice";

// handleRedialRequest touches only the link bookkeeping, so the peer
// connection can be a state holder and the audio graph never comes up.
function fakeRemote(state: string, ageMs = 0) {
  return {
    peerId: "aaa",
    pc: { connectionState: state, close: vi.fn() },
    stream: null,
    audio: { srcObject: null },
    sourceNode: null,
    gainNode: null,
    sigStream: null,
    pendingCandidates: [],
    createdAt: Date.now() - ageMs,
    everConnected: false,
    okAt: Date.now(),
  };
}

function makeVoice(remoteState: string | null, ageMs = 0) {
  const transport = {
    selfId: () => "zzz", // higher than "aaa": we are the pair's dialer
    peers: () => ["aaa"],
    isRelay: () => false,
    send: async () => {},
    on: () => {},
    off: () => {},
  };
  const voice = new LibP2PVoice(transport as never, null);
  const internals = voice as never as Record<string, unknown>;
  internals.node = {} as unknown;
  internals.callPeers = new Set(["aaa"]);
  if (remoteState) {
    (internals.remotePeers as Map<string, unknown>).set(
      "aaa",
      fakeRemote(remoteState, ageMs)
    );
  }
  return { voice, internals };
}

describe("handleRedialRequest", () => {
  let dialed: string[];
  beforeEach(() => {
    dialed = [];
  });

  const spyDial = (internals: Record<string, unknown>) => {
    internals.dialAndOffer = async (peerId: string) => {
      dialed.push(peerId);
    };
  };

  it("rebuilds even when our own connection still reads connected", () => {
    // The far side tore its link down; ours will sit at "connected" until ICE
    // consent expires. Their word beats our stale state.
    const { voice, internals } = makeVoice("connected");
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
    expect((internals.remotePeers as Map<string, unknown>).has("aaa")).toBe(
      false
    );
  });

  it("rebuilds a handshake that has been stuck longer than any real one takes", () => {
    // Every rebuild used to look "mid-handshake" again, so the third
    // caller's asks were refused forever and only a manual rejoin healed it.
    const { voice, internals } = makeVoice("connecting", 15_000);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it("leaves a link that is still mid-handshake alone", () => {
    const { voice, internals } = makeVoice("connecting");
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual([]);
    expect((internals.remotePeers as Map<string, unknown>).has("aaa")).toBe(
      true
    );
  });

  it("does not spend the rate-limit slot on a refused ask", () => {
    const { voice, internals } = makeVoice("connecting");
    spyDial(internals);
    voice.handleRedialRequest("aaa"); // refused, mid-handshake
    // The link dies; the next ask must land rather than wait out the limit.
    (
      (internals.remotePeers as Map<string, { pc: { connectionState: string } }>)
        .get("aaa")!
    ).pc.connectionState = "failed";
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it("serves at most one rebuild per interval", () => {
    const { voice, internals } = makeVoice(null);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });
});
