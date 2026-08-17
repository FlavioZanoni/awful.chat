/**
 * The libp2p key for THIS device.
 *
 * It must not be the identity key. Two devices signed into the same account
 * share one identity, and deriving the peerId from it gave them the same
 * peerId - a relay reservation is per peerId and a node refuses to dial its
 * own, so the second device could never connect.
 *
 * Kept in localStorage rather than IndexedDB because device sync copies IDB
 * sections across: this key has to stay on the device that generated it.
 */

const KEY = "awful_device_key";

let cached: Uint8Array | null = null;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A stable 32 byte seed unique to this device. Stable matters: the peerId is
 * derived from it, and a peerId that changed every reload would churn every
 * peer's connection state.
 */
export function deviceKeySeed(): Uint8Array {
  if (cached) return cached;
  let seed: Uint8Array | null = null;
  try {
    seed = fromHex(localStorage.getItem(KEY) ?? "");
  } catch {
    seed = null;
  }
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32));
    try {
      localStorage.setItem(KEY, toHex(seed));
    } catch {
      // Private mode or storage blocked: the peerId is then per session, which
      // still connects, it just does not survive a reload.
    }
  }
  cached = seed;
  return seed;
}
