/**
 * backup.ts - the on-disk/on-wire shape of a database export.
 *
 * Pure format logic only (no DOM, no IndexedDB, no runes) so it can be unit
 * tested: a backup file is untrusted input, and both the file restore and the
 * QR device sync depend on it round-tripping without silently dropping data.
 */

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
  data?: number[]; // ArrayBuffer converted to number[] for JSON serialization
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
export const BACKUP_VERSION = 1;

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
