import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { resolveToDid } from "./identity-utils";
import { publicKeyToDid } from "./identity";
import { peerBindingContent, verifyPeerBinding } from "../messaging";

const utf8 = (s: string) => new TextEncoder().encode(s);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A device's libp2p key is NOT its identity key - two devices on one account
// would otherwise share a peerId and never connect. That means the DID cannot
// be computed from the peerId any more, so the link between the two is a
// signature. If this check ever breaks, any peer could claim to be anyone.
describe("peer binding", () => {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 3) & 0xff;
  const did = publicKeyToDid(ed25519.getPublicKey(seed));
  const peerId = "12D3KooWSomeDevicePeerId";

  it("accepts a signature made by the DID over its own peerId", async () => {
    const sig = hex(ed25519.sign(utf8(peerBindingContent(did, peerId)), seed));
    expect(await verifyPeerBinding(did, peerId, sig)).toBe(true);
  });

  it("rejects the same signature presented for a different peerId", async () => {
    const sig = hex(ed25519.sign(utf8(peerBindingContent(did, peerId)), seed));
    expect(await verifyPeerBinding(did, "12D3KooWSomeoneElse", sig)).toBe(
      false
    );
  });

  it("rejects a binding signed by somebody else's key", async () => {
    const attacker = new Uint8Array(32).fill(42);
    const sig = hex(ed25519.sign(utf8(peerBindingContent(did, peerId)), attacker));
    expect(await verifyPeerBinding(did, peerId, sig)).toBe(false);
  });

  it("rejects missing or empty proof", async () => {
    expect(await verifyPeerBinding(did, peerId, "")).toBe(false);
    expect(await verifyPeerBinding("", peerId, "aa")).toBe(false);
  });
});

describe("resolveToDid", () => {
  it("passes DIDs through unchanged", () => {
    const did = "did:key:zAbc";
    expect(resolveToDid(did, new Map())).toBe(did);
  });

  it("uses a learned mapping", () => {
    const map = new Map([["12D3KooWfake", "did:key:zLearned"]]);
    expect(resolveToDid("12D3KooWfake", map)).toBe("did:key:zLearned");
  });

  it("returns the peerId unchanged when nothing is known about it", () => {
    // Inventing a DID here would attribute messages to an identity that does
    // not exist, which is worse than leaving the peerId visible.
    expect(resolveToDid("12D3KooWunknown", new Map())).toBe("12D3KooWunknown");
  });
});
