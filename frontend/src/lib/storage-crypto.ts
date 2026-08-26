/**
 * At-rest encryption for IndexedDB records.
 *
 * Why: IndexedDB deletion is not erasure - Chromium's LevelDB keeps old
 * values in immutable segment files until a compaction the page cannot
 * trigger, so anything ever written in plaintext must be assumed
 * recoverable by forensics. The mitigation is crypto-shredding: the disk
 * only ever holds AES-GCM ciphertext, and destroying (or simply never
 * yielding) the key makes every remnant worthless.
 *
 * The key derives from the identity's ed25519 private key via HKDF with a
 * purpose label, so:
 *  - it exists only while the identity is unlocked (never stored anywhere),
 *  - every device of the same identity derives the same key, which is what
 *    lets device sync and backups round-trip through plaintext exports,
 *  - the only disk artifact that can reach it is the mnemonic record, which
 *    is itself AES-GCM under the unlock password's PBKDF2 key.
 *
 * Record layout: index/keyPath fields the queries need stay in clear;
 * everything else is one AES-GCM blob per record (fresh 12-byte IV each
 * write), with ArrayBuffer fields (file bytes, avatars) encrypted as raw
 * buffers beside it - base64ing megabytes into JSON would triple the work.
 */

interface EncBlob {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export interface SealedRow {
  [k: string]: unknown;
  /** AES-GCM over the JSON of every non-clear, non-byte field. */
  _enc: EncBlob;
  /** AES-GCM over raw ArrayBuffer fields, keyed by field name. */
  _encBytes?: Record<string, EncBlob>;
}

export interface StoreCryptoSpec {
  /** Fields kept in plaintext: the keyPath and every indexed/query field. */
  clear: string[];
  /** ArrayBuffer fields encrypted as raw buffers instead of via JSON. */
  bytes?: string[];
}

let _key: CryptoKey | null = null;
let _plaintextImportDepth = 0;

/**
 * Open a scoped window in which sealRow passes records through as PLAINTEXT
 * when no key is armed, instead of throwing. Exists for exactly one caller:
 * database import on a device that has not unlocked yet (QR device sync onto
 * a fresh install, replace-mode backup restore) - there is no key to seal
 * with because deriving it needs the password the user has not typed. The
 * caller must mark the at-rest sweep as needed so the first unlock seals
 * these rows. Everywhere else the no-key throw stands.
 */
export function beginPlaintextImport(): () => void {
  _plaintextImportDepth += 1;
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      _plaintextImportDepth -= 1;
    }
  };
}

/** Derive and arm the storage key. Call on unlock, with the session's
 *  ed25519 private key scalar; the label separates this use from signing. */
export async function initStorageCrypto(
  privateKey: Uint8Array<ArrayBuffer>
): Promise<void> {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const ikm = await crypto.subtle.importKey("raw", privateKey, "HKDF", false, [
    "deriveKey",
  ]);
  _key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("awful.chat storage at-rest v1"),
      info: utf8("storage-key"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Drop the key. Call on lock/logout; sealed rows become unreadable. */
export function clearStorageCrypto(): void {
  _key = null;
}

export function storageCryptoReady(): boolean {
  return _key !== null;
}

function requireKey(): CryptoKey {
  if (!_key) {
    // Refusing beats falling back: a silent plaintext write would defeat
    // the whole scheme the first time a code path ran before unlock.
    throw new Error("storage is locked: no at-rest key (unlock first)");
  }
  return _key;
}

async function encrypt(key: CryptoKey, data: BufferSource): Promise<EncBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv, ct };
}

async function decrypt(key: CryptoKey, blob: EncBlob): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv as Uint8Array<ArrayBuffer> },
    key,
    blob.ct
  );
}

export function isSealed(row: unknown): row is SealedRow {
  return !!row && typeof row === "object" && "_enc" in (row as object);
}

/** Encrypt a record for storage. Clear fields are copied through; the rest
 *  becomes one ciphertext blob (byte fields their own raw blobs). */
export async function sealRow<T extends Record<string, unknown>>(
  record: T,
  spec: StoreCryptoSpec
): Promise<SealedRow> {
  if (!_key && _plaintextImportDepth > 0) {
    // Locked import: the row lands plaintext (legacy layout) and the
    // at-rest sweep seals it on the first unlock.
    return record as unknown as SealedRow;
  }
  const key = requireKey();
  const out: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  const byteSet = new Set(spec.bytes ?? []);
  const clearSet = new Set(spec.clear);
  let encBytes: Record<string, EncBlob> | undefined;

  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (clearSet.has(k)) {
      out[k] = v;
    } else if (byteSet.has(k)) {
      const buf = new Uint8Array(
        v instanceof ArrayBuffer ? v : (v as Uint8Array<ArrayBuffer>).slice()
      ) as Uint8Array<ArrayBuffer>;
      (encBytes ??= {})[k] = await encrypt(key, buf);
    } else {
      rest[k] = v;
    }
  }

  out._enc = await encrypt(key, new TextEncoder().encode(JSON.stringify(rest)));
  if (encBytes) out._encBytes = encBytes;
  return out as SealedRow;
}

/** Decrypt a stored row back to the full record. Rows written before the
 *  at-rest migration have no _enc and pass through unchanged.
 *  skipBytes leaves ArrayBuffer fields out - for scans that only need the
 *  small metadata and must not materialize every file blob. */
export async function openRow<T>(
  row: unknown,
  spec: StoreCryptoSpec,
  opts?: { skipBytes?: boolean }
): Promise<T> {
  if (!isSealed(row)) return row as T;
  const key = requireKey();
  const json = new TextDecoder().decode(await decrypt(key, row._enc));
  const rest = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  for (const k of spec.clear) {
    if (k in row) out[k] = (row as Record<string, unknown>)[k];
  }
  if (row._encBytes && !opts?.skipBytes) {
    for (const [k, blob] of Object.entries(row._encBytes)) {
      out[k] = await decrypt(key, blob);
    }
  }
  return out as T;
}

/** Whether a row (sealed or legacy) carries bytes for the given field. */
export function rowHasBytes(row: unknown, field: string): boolean {
  if (!row || typeof row !== "object") return false;
  if (isSealed(row)) {
    return !!row._encBytes?.[field] || !!(row as Record<string, unknown>)[field];
  }
  return !!(row as Record<string, unknown>)[field];
}

/** Open many rows, DROPPING the ones that fail to decrypt (truncated blob,
 *  row sealed under a different identity's key) instead of failing the whole
 *  query - one corrupt row must degrade to one missing row, not a blank app. */
export async function openRows<T>(
  rows: unknown[],
  spec: StoreCryptoSpec
): Promise<T[]> {
  const settled = await Promise.allSettled(
    rows.map((r) => openRow<T>(r, spec))
  );
  const out: T[] = [];
  let dropped = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(s.value);
    else dropped += 1;
  }
  if (dropped > 0) {
    console.warn(`[storage] dropped ${dropped} undecryptable row(s)`);
  }
  return out;
}

// ── per-store specs ──────────────────────────────────────────────────────────
// Clear = keyPath + indexed fields + fields hot paths filter on WITHOUT
// wanting a decrypt (unread counts, watermark sweeps, page-fill filters).
// Everything content-bearing stays inside the blob.

export const STORE_SPECS = {
  messages: {
    clear: ["id", "roomCode", "lamport", "senderId", "type"],
  },
  attachments: {
    clear: ["id", "roomCode", "messageId", "infoHash", "status"],
    bytes: ["data"],
  },
  rooms: {
    clear: ["roomCode", "type"],
    bytes: ["pfpData"],
  },
  profiles: {
    clear: ["did", "isMe"],
    bytes: ["pfpData", "bannerData"],
  },
  phonebook: {
    clear: ["peerId"],
  },
  savedGifs: {
    clear: ["id", "gifId"],
    bytes: ["data"],
  },
  pending: {
    clear: ["id", "to"],
  },
  // Yjs updates ARE channel content; only watermarks (pure sync counters,
  // needed clear for digest sweeps) and the identity store (already under
  // the password's PBKDF2 key) stay outside this list. A NEW STORE added to
  // the schema must be added here too, or it ships plaintext by omission.
  yjsDocs: {
    clear: ["id"],
    bytes: ["update"],
  },
} as const satisfies Record<string, StoreCryptoSpec>;

export type EncryptedStoreName = keyof typeof STORE_SPECS;
