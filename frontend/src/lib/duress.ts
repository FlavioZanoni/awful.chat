/**
 * Duress password: entered at the unlock screen instead of the real
 * password, it wipes this device's data and lands on the fresh-install
 * screen - indistinguishable from a device that never had an account.
 *
 * What makes the wipe real is the at-rest layer (storage-crypto.ts): the
 * database only ever held AES-GCM ciphertext keyed off the identity, so
 * even the IndexedDB remnants LevelDB keeps around after deletion are
 * noise. The wipe here is cleanup plus removing the (password-encrypted)
 * mnemonic blob - the one artifact a forensic pass could try to attack,
 * and it still needs the REAL password.
 *
 * Only a salted PBKDF2 hash of the duress password is stored, in
 * localStorage - it must be checkable while the identity is LOCKED, and it
 * protects nothing (matching it triggers destruction, not access). The
 * identity's own password is never stored in any form, same as before.
 */

const DURESS_KEY = "awful:duress:v1";
const ITERATIONS = 100_000;

interface DuressRecord {
  salt: string; // base64
  hash: string; // base64 PBKDF2-SHA-256 output
  iterations: number;
}

const b64 = (buf: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<string> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    256
  );
  return b64(bits);
}

function readRecord(): DuressRecord | null {
  try {
    const raw = localStorage.getItem(DURESS_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as DuressRecord;
    if (!rec.salt || !rec.hash || !rec.iterations) return null;
    return rec;
  } catch {
    return null;
  }
}

export function hasDuressPassword(): boolean {
  return readRecord() !== null;
}

export async function setDuressPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  localStorage.setItem(
    DURESS_KEY,
    JSON.stringify({
      salt: b64(salt),
      hash,
      iterations: ITERATIONS,
    } satisfies DuressRecord)
  );
}

export function clearDuressPassword(): void {
  try {
    localStorage.removeItem(DURESS_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

/** True when the entered password is the duress password. Constant-shaped:
 *  one PBKDF2 either way once a record exists. */
export async function isDuressPassword(password: string): Promise<boolean> {
  const rec = readRecord();
  if (!rec) return false;
  const hash = await derive(password, unb64(rec.salt), rec.iterations);
  // Non-secret comparison: both sides are PBKDF2 outputs, and a "match"
  // grants destruction, not access.
  return hash === rec.hash;
}

/**
 * Destroy this device's data: every IndexedDB database (identity, messages,
 * files - all of it), web storage, and every Cache Storage bucket, then
 * reload into the fresh-install flow. Strictly local and silent: no network
 * writes, no room leaves - outbound traffic at wipe time is itself a tell.
 * Never returns.
 */
export async function executeDuressWipe(): Promise<never> {
  const jobs: Promise<unknown>[] = [];

  try {
    // databases() lists everything (share-target's DB included); the fixed
    // name is the fallback for browsers without it.
    const dbs = (await indexedDB.databases?.()) ?? [{ name: "awful-chat" }];
    for (const { name } of dbs) {
      if (name) {
        jobs.push(
          new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve(null);
          })
        );
      }
    }
  } catch {
    // Fall through - storage clears below still run.
  }

  try {
    localStorage.clear();
  } catch {
    /* blocked storage cannot hold anything either */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* same */
  }

  try {
    const keys = await caches.keys();
    jobs.push(...keys.map((k) => caches.delete(k)));
  } catch {
    /* no Cache Storage access */
  }

  await Promise.allSettled(jobs);
  // Replace, not assign: the wiping page must not sit in history.
  location.replace("/");
  return new Promise<never>(() => {});
}
