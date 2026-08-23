/**
 * backup.ts - the on-disk/on-wire shape of a database export.
 *
 * Pure format logic only (no DOM, no IndexedDB, no runes) so it can be unit
 * tested: a backup file is untrusted input, and both the file restore and the
 * QR device sync depend on it round-tripping without silently dropping data.
 */

import { base64ToBytes } from "../utils";
import type { Message, Attachment, PendingMessage } from "../types/message";
import type {
  Room,
  DMRoom,
  PeerProfile,
  OwnProfile,
  SavedGif,
  WatermarkRecord,
} from "../storage";

export interface AttachmentExport {
  id: string;
  roomCode: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  infoHash: string;
  /**
   * Base64 (current) or number[] (older exports). number[] quadrupled the
   * bytes as JSON text, which blew the 4MB sync frame cap on any real image
   * batch - the "stuck at 90%/20%" device sync.
   */
  data?: string | number[];
  status: Attachment["status"];
  createdAt: number;
}

export interface DatabaseExport {
  identity?: {
    mnemonic: {
      salt: number[];
      iv: number[];
      encrypted: number[];
      /**
       * PBKDF2 iteration count the mnemonic was encrypted with. MUST travel
       * with the record: the receiving device derives the key with it, and
       * guessing wrong makes the correct password look wrong. Absent means the
       * legacy 100k count (records written before this field existed).
       */
      iterations?: number;
    };
    keypair: { did: string; publicKey: number[] };
    // webauthn is intentionally NOT exported: the credential is bound to the
    // source device's authenticator and would only present a broken
    // biometric-unlock option elsewhere.
  };
  messages: Message[];
  attachments: AttachmentExport[];
  pending: PendingMessage[];
  watermarks: WatermarkRecord[];
  yjsDocs: { id: string; update: number[] }[];
  rooms: (Room | DMRoom)[];
  profiles: (PeerProfile | OwnProfile)[];
  savedGifs: SavedGif[];
}

export const BACKUP_FORMAT = "awful.chat/backup";
// v2: attachment and saved-gif bytes are base64 strings, not number[]. An
// old build restoring a v2 file would coerce the string to garbage bytes, so
// it must refuse cleanly on the version instead.
export const BACKUP_VERSION = 2;

export interface BackupFile extends DatabaseExport {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
}

export interface BackupSummary {
  hasIdentity: boolean;
  did: string | null;
  exportedAt: number | null;
  messages: number;
  rooms: number;
  attachments: number;
  profiles: number;
}

// Rooms and profiles carry avatar bytes in an ArrayBuffer, which JSON turns
// into `{}` - silently losing the image on both a file backup and the QR sync.
// Convert to a plain number[] on the way out and back on the way in.
export function pfpToJson<T extends { pfpData?: unknown }>(rec: T): T {
  const data = rec?.pfpData;
  if (!data || Array.isArray(data)) return rec;
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return rec;
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return { ...rec, pfpData: Array.from(bytes) };
}

/**
 * Merge an imported room over the locally stored one (device sync, "add"
 * mode). Field rules mirror the monotonic guards used at runtime: the seen
 * watermark and per-participant activity never move backwards, membership is
 * a union, and a real local name is not overwritten by the import.
 */
export function mergeImportedRoom<T extends Room>(local: Room, imported: T): T {
  const participantLastSeen: Record<string, number> = {};
  for (const [did, ts] of Object.entries(local.participantLastSeen ?? {})) {
    participantLastSeen[did] = ts ?? 0;
  }
  for (const [did, ts] of Object.entries(imported.participantLastSeen ?? {})) {
    participantLastSeen[did] = Math.max(participantLastSeen[did] ?? 0, ts ?? 0);
  }
  return {
    ...imported,
    lastSeenLamport: Math.max(
      local.lastSeenLamport ?? 0,
      imported.lastSeenLamport ?? 0
    ),
    createdAt: Math.min(
      local.createdAt ?? Infinity,
      imported.createdAt ?? Infinity
    ),
    participants: [
      ...new Set([
        ...(local.participants ?? []),
        ...(imported.participants ?? []),
      ]),
    ],
    participantLastSeen,
    name:
      !local.name || local.name === local.roomCode ? imported.name : local.name,
  };
}

/** Accept both encodings of exported bytes; undefined for anything else. */
export function bytesFromExport(
  data: string | number[] | undefined
): ArrayBuffer | undefined {
  if (typeof data === "string") {
    try {
      return base64ToBytes(data).buffer;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  return undefined;
}

export function pfpFromJson<T extends { pfpData?: unknown }>(rec: T): T {
  const data = rec?.pfpData;
  if (!data) return rec;
  if (Array.isArray(data)) {
    return { ...rec, pfpData: new Uint8Array(data as number[]).buffer };
  }
  if (data instanceof ArrayBuffer) return rec;
  // `{}` from an older peer that serialized the buffer lossily - drop it
  // rather than persist an unusable value.
  const { pfpData: _drop, ...rest } = rec as Record<string, unknown>;
  return rest as T;
}

/**
 * Parse and validate backup JSON.
 * Missing collections are coerced to empty arrays so a partial file cannot
 * crash the import half way through.
 *
 * @throws if the text is not a backup this build understands.
 */
export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON");
  }
  const d = parsed as Partial<BackupFile> | null;
  if (!d || typeof d !== "object" || d.format !== BACKUP_FORMAT) {
    throw new Error("That file is not an awful.chat backup");
  }
  if (typeof d.version !== "number" || d.version > BACKUP_VERSION) {
    throw new Error("That backup was made by a newer version of the app");
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    format: BACKUP_FORMAT,
    version: d.version,
    exportedAt: typeof d.exportedAt === "number" ? d.exportedAt : 0,
    identity: d.identity,
    messages: arr(d.messages),
    attachments: arr(d.attachments),
    pending: arr(d.pending),
    watermarks: arr(d.watermarks),
    yjsDocs: arr(d.yjsDocs),
    rooms: arr(d.rooms),
    profiles: arr(d.profiles),
    savedGifs: arr(d.savedGifs),
  };
}

export function summarizeBackup(data: BackupFile): BackupSummary {
  return {
    hasIdentity: !!data.identity,
    did: data.identity?.keypair?.did ?? null,
    exportedAt: data.exportedAt || null,
    messages: data.messages.length,
    rooms: data.rooms.length,
    attachments: data.attachments.length,
    profiles: data.profiles.length,
  };
}
