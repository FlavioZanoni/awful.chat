// Rate limiting for the inbound sync surface, lifted out of
// transport.svelte.ts so it can be tested (that module builds a libp2p node
// at import time).
//
// Every expensive REACTION to a peer's frame goes through here: a digest
// making us decrypt and push history (inline attachment bytes included), a
// forged "you are behind" making us reply, a bare SyncComplete making us
// fan a digest out to the whole room. All of them were unthrottled: our own
// outbound digests debounce, but a room member looping a few-hundred-byte
// frame could make us re-run the reaction at line rate - bandwidth and CPU
// amplification behind the membership boundary.
//
// A hard window, deliberately without a "their watermarks changed" bypass:
// any bypass condition is attacker-controlled (vary one invented sender per
// frame) and would defeat the throttle entirely. Honest flows fit the
// window - one push hands over everything missing, and the repair tick is
// slower than this.
export const SYNC_REACTION_MIN_MS = 10_000;

const _lastReactionAt = new Map<string, number>();

/**
 * True (and records the reaction) when `key` has not reacted inside the
 * window. Key by reaction kind plus its scope, e.g. `push|<peer>|<room>`,
 * `reply|<peer>|<room>`, `fanout|<room>`.
 */
export function allowSyncReaction(key: string, now = Date.now()): boolean {
  const at = _lastReactionAt.get(key);
  if (at !== undefined && now - at < SYNC_REACTION_MIN_MS) return false;
  _lastReactionAt.set(key, now);
  return true;
}

/** Test seam. */
export function _resetSyncThrottle(): void {
  _lastReactionAt.clear();
}
