/**
 * Shared per-peer voice quality, fed from the transport status stream in
 * voice.svelte.ts. CallStatus used to hold this map privately, which meant
 * the ONE aggregate badge was the only feedback anywhere - a pair that
 * could not hear each other looked exactly like a healthy call on every
 * tile. Tiles read this to mark the specific peer that is degraded/failed.
 */
import {
  applyCallQualityStatus,
  noteTrackAdded,
  type CallQualityStatusEvent,
  type PeerVoiceQuality,
} from "./call-quality";

export const peerQualityState = $state({
  peers: new Map<string, PeerVoiceQuality>() as ReadonlyMap<
    string,
    PeerVoiceQuality
  >,
});

export function applyPeerQualityEvent(event: CallQualityStatusEvent): void {
  const next = applyCallQualityStatus(peerQualityState.peers, event);
  if (next !== peerQualityState.peers) peerQualityState.peers = next;
}

export function notePeerQualityTrack(peerId: string): void {
  const next = noteTrackAdded(peerQualityState.peers, peerId);
  if (next !== peerQualityState.peers) peerQualityState.peers = next;
}

/** Call teardown: verdicts are about links that no longer exist. */
export function resetPeerQuality(): void {
  if (peerQualityState.peers.size > 0) peerQualityState.peers = new Map();
}
