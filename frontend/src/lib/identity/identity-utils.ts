/**
 * Identity utilities for handling peerId/DID conversions and validation
 */

import { peerIdFromString } from "@libp2p/peer-id";
import { publicKeyToDid } from "./identity";

export function looksLikePeerId(value: string): boolean {
  return value.startsWith("12D3") || value.startsWith("Qm");
}

/**
 * Derive the did:key for a libp2p peerId *cryptographically*.
 * A peer's Ed25519 libp2p peerId and their did:key both encode the SAME
 * public key, so the DID can be recovered from the authenticated peerId with
 * no need to trust an (unsigned, spoofable) `did` field on the wire.
 * Returns null for non-Ed25519 peerIds or unparseable input.
 */
export function didFromPeerId(peerId: string): string | null {
  try {
    const pid = peerIdFromString(peerId);
    if (pid.type !== "Ed25519" || !pid.publicKey) return null;
    return publicKeyToDid(pid.publicKey.raw);
  } catch {
    return null;
  }
}

export function looksLikeDid(value: string): boolean {
  return value.startsWith("did:");
}

/**
 * Resolve a peer identifier (peerId or DID) to its DID.
 * Returns the DID if found, otherwise returns the input as-is.
 */
export function resolveToDid(
  peerIdOrDid: string,
  peerIdToDidMap: Map<string, string>
): string {
  if (looksLikeDid(peerIdOrDid)) return peerIdOrDid;
  // Prefer a learned mapping, else derive the DID from the peerId itself so a
  // conversation never fragments across a peerId-keyed and a DID-keyed room.
  return (
    peerIdToDidMap.get(peerIdOrDid) ??
    didFromPeerId(peerIdOrDid) ??
    peerIdOrDid
  );
}

/**
 * Find peerId for a given DID from the mapping.
 * Returns null if not found.
 */
export function didToPeerId(
  did: string,
  peerIdToDidMap: Map<string, string>
): string | null {
  for (const [peerId, mappedDid] of peerIdToDidMap) {
    if (mappedDid === did) return peerId;
  }
  return null;
}
