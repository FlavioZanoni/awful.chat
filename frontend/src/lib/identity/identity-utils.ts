/**
 * Identity utilities for handling peerId/DID conversions and validation
 */


export function looksLikePeerId(value: string): boolean {
  return value.startsWith("12D3") || value.startsWith("Qm");
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
  // Only a learned mapping will do. A DID can no longer be computed from a
  // peerId - devices carry their own libp2p keys - and deriving one anyway
  // would invent an identity that belongs to nobody.
  return peerIdToDidMap.get(peerIdOrDid) ?? peerIdOrDid;
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
