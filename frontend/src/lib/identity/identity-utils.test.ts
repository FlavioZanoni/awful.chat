import { describe, it, expect } from "vitest";
import { keys } from "@libp2p/crypto";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { ed25519 } from "@noble/curves/ed25519.js";
import { didFromPeerId, resolveToDid } from "./identity-utils";
import { publicKeyToDid } from "./identity";

// The whole DID-authentication fix rests on one fact: a peer's Ed25519 libp2p
// peerId and their did:key encode the SAME public key. If this ever drifts,
// didFromPeerId would hand back the wrong identity and profile/DM spoofing
// protection would silently break.
describe("didFromPeerId", () => {
  it("derives the same DID the identity module derives from the same seed", async () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 3) & 0xff;

    // identity.ts path: seed -> ed25519 pubkey -> did
    const didFromIdentity = publicKeyToDid(ed25519.getPublicKey(seed));

    // transport.ts path: seed -> libp2p peerId
    const libp2pKey = await keys.generateKeyPairFromSeed("Ed25519", seed);
    const peerId = peerIdFromPrivateKey(libp2pKey).toString();

    expect(didFromPeerId(peerId)).toBe(didFromIdentity);
  });

  it("returns null for non-peerId input instead of throwing", () => {
    expect(didFromPeerId("not-a-peer-id")).toBeNull();
    expect(didFromPeerId("")).toBeNull();
  });
});

describe("resolveToDid", () => {
  it("passes DIDs through unchanged", () => {
    const did = "did:key:zAbc";
    expect(resolveToDid(did, new Map())).toBe(did);
  });

  it("prefers a learned mapping over derivation", () => {
    const map = new Map([["12D3KooWfake", "did:key:zLearned"]]);
    expect(resolveToDid("12D3KooWfake", map)).toBe("did:key:zLearned");
  });

  it("derives the DID from an Ed25519 peerId when no mapping exists", async () => {
    const seed = new Uint8Array(32).fill(9);
    const libp2pKey = await keys.generateKeyPairFromSeed("Ed25519", seed);
    const peerId = peerIdFromPrivateKey(libp2pKey).toString();
    const expected = publicKeyToDid(ed25519.getPublicKey(seed));
    expect(resolveToDid(peerId, new Map())).toBe(expected);
  });
});
