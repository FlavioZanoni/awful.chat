/**
 * Fault injection for tests. Stripped from production builds.
 *
 * The bugs that actually bite this app are partial failures: a message that
 * never arrives, a peer that cannot be dialled, a connect event that never
 * fires because the other side never noticed the drop. None of those happen on
 * a loopback, where every dial succeeds first try and nothing is ever lost, so
 * a test has to cause them on purpose.
 *
 * Drive it from a test with `window.__faults`:
 *
 *   __faults.set({ drop: ["sync_digest"] })   // sync silently fails
 *   __faults.set({ blockDial: ["*"] })        // nobody is reachable
 *   __faults.set({ suppress: ["connect"] })   // connection lives, event does not
 *   __faults.clear()                          // then assert it recovers
 */

export interface FaultConfig {
  /** Wire message `type` values to drop on the way out. */
  drop: string[];
  /** Probability 0..1 of dropping any outbound frame, applied after `drop`. */
  dropProbability: number;
  /** peerIds that cannot be dialled; "*" for all. */
  blockDial: string[];
  /** Transport events to swallow: "connect" | "disconnect" | "message". */
  suppress: string[];
}

const EMPTY: FaultConfig = {
  drop: [],
  dropProbability: 0,
  blockDial: [],
  suppress: [],
};

let active: FaultConfig = { ...EMPTY };
let enabled = false;

/** Counters so a test can assert a fault actually bit. */
export const faultStats = {
  droppedFrames: 0,
  blockedDials: 0,
  suppressedEvents: 0,
};

export function faultsActive(): boolean {
  return enabled;
}

function frameType(data: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as {
      type?: unknown;
    };
    return typeof parsed.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

/** True if this outbound frame should be thrown away. */
export function shouldDropFrame(data: Uint8Array): boolean {
  if (!enabled) return false;
  if (active.drop.length > 0) {
    const type = frameType(data);
    if (type && active.drop.includes(type)) {
      faultStats.droppedFrames++;
      return true;
    }
  }
  if (active.dropProbability > 0 && Math.random() < active.dropProbability) {
    faultStats.droppedFrames++;
    return true;
  }
  return false;
}

export function shouldBlockDial(peerId: string): boolean {
  if (!enabled) return false;
  const blocked =
    active.blockDial.includes("*") || active.blockDial.includes(peerId);
  if (blocked) faultStats.blockedDials++;
  return blocked;
}

export function shouldSuppressEvent(event: string): boolean {
  if (!enabled) return false;
  const hit = active.suppress.includes(event);
  if (hit) faultStats.suppressedEvents++;
  return hit;
}

/** Exposed on window in dev so a browser test can drive it. */
export function installFaultHook(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__faults = {
    set(config: Partial<FaultConfig>) {
      active = { ...EMPTY, ...config };
      enabled = true;
      return active;
    },
    clear() {
      active = { ...EMPTY };
      enabled = false;
      return "cleared";
    },
    stats: () => ({ ...faultStats }),
    reset() {
      faultStats.droppedFrames = 0;
      faultStats.blockedDials = 0;
      faultStats.suppressedEvents = 0;
      return "reset";
    },
  };
}
