import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibP2PVoice } from "./voice";

// handleRedialRequest touches only the link bookkeeping, so the peer
// connection can be a state holder and the audio graph never comes up.
function fakeRemote(state: string, ageMs = 0, everConnected = false, okAgoMs = 0) {
  return {
    peerId: "aaa",
    pc: { connectionState: state, close: vi.fn() },
    stream: null,
    audio: { srcObject: null },
    sourceNode: null,
    gainNode: null,
    pendingCandidates: [],
    createdAt: Date.now() - ageMs,
    everConnected,
    okAt: Date.now() - okAgoMs,
  };
}

function makeVoice(
  remoteState: string | null,
  ageMs = 0,
  everConnected = false,
  okAgoMs = 0
) {
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
      fakeRemote(remoteState, ageMs, everConnected, okAgoMs)
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

  it("refuses an ask during a fresh blip on an established link", () => {
    // "disconnected" seconds after being connected may recover by itself
    // (ICE restart); the ask must not flap a link mid-recovery.
    const { voice, internals } = makeVoice("disconnected", 60_000, true, 1_000);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual([]);
  });

  it("serves once an established link has sat blipped with no progress", () => {
    // Past the blip grace with okAt untouched there is no recovery in
    // flight. Waiting out the full 20s wedge grace here was most of the
    // "voice takes forever to come back".
    const { voice, internals } = makeVoice("disconnected", 60_000, true, 6_000);
    spyDial(internals);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
  });

  it("clears the dial backoff when it serves an ask", () => {
    const { voice, internals } = makeVoice("connected");
    spyDial(internals);
    (internals.nextDialAt as Map<string, number>).set(
      "aaa",
      Date.now() + 8_000
    );
    (internals.dialBackoff as Map<string, number>).set("aaa", 8_000);
    voice.handleRedialRequest("aaa");
    expect(dialed).toEqual(["aaa"]);
    expect((internals.nextDialAt as Map<string, number>).has("aaa")).toBe(false);
    expect((internals.dialBackoff as Map<string, number>).has("aaa")).toBe(
      false
    );
  });
});

describe("reconcileLinks asks for a blipped link, not only a missing one", () => {
  function makePassiveVoice(everConnected: boolean, okAgoMs: number) {
    const sent: string[] = [];
    const transport = {
      selfId: () => "aaa", // LOWER than "zzz": we are the passive side
      peers: () => ["zzz"],
      isRelay: () => false,
      send: async (peerId: string) => {
        sent.push(peerId);
        return true;
      },
      on: () => {},
      off: () => {},
    };
    const voice = new LibP2PVoice(transport as never, null);
    const internals = voice as never as Record<string, unknown>;
    internals.node = {} as unknown;
    internals.callPeers = new Set(["zzz"]);
    internals.rosterSeen = true;
    const remote = { ...fakeRemote("disconnected", 60_000, everConnected, okAgoMs), peerId: "zzz" };
    (internals.remotePeers as Map<string, unknown>).set("zzz", remote);
    // Keep the reconcile from tearing the link down before the ask branch
    // runs: linkIsHealthy passes while okAt is inside the 20s wedge grace.
    return { voice, internals, sent };
  }

  it("asks while the blipped link still exists, once the blip grace passes", () => {
    const { internals, sent } = makePassiveVoice(true, 6_000);
    (internals.reconcileLinks as () => void).call(internals);
    expect(sent).toEqual(["zzz"]);
  });

  it("stays quiet during a fresh blip", () => {
    const { internals, sent } = makePassiveVoice(true, 1_000);
    (internals.reconcileLinks as () => void).call(internals);
    expect(sent).toEqual([]);
  });
});
