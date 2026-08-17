/**
 * sync.svelte.ts
 *
 * Device-to-device sync using QR codes and P2P connection.
 * Both devices connect to a temporary sync room via the standard transport layer.
 */

import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";
import type { PeerTransport } from "./types";
import { LibP2PTransport } from "./libp2p/transport";
import {
  getDB,
  wipeLocalDatabase,
  putIdentityRecord,
  putMessage,
  putAttachment,
  putRoom,
  putPeerProfile,
  putOwnProfile,
  putSavedGif,
} from "../storage";
import type { Message, Attachment, PendingMessage } from "../types/message";
import type {
  Room,
  DMRoom,
  PeerProfile,
  OwnProfile,
  SavedGif,
  WatermarkRecord,
} from "../storage";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  parseBackup,
  pfpFromJson,
  pfpToJson,
  type AttachmentExport,
  type BackupFile,
  type DatabaseExport,
} from "./backup";

export { summarizeBackup } from "./backup";
export type { BackupFile, BackupSummary } from "./backup";

export interface SyncPayload {
  roomCode: string;
  token: string;
  expires: number;
  mode?: "add" | "replace";
  password?: string;
}

enum SyncMessageType {
  ExportRequest = "sync_export_request",
  ExportData = "sync_export_data",
  ExportAck = "sync_export_ack",
  ExportComplete = "sync_export_complete",
  SyncError = "sync_error",
}

interface SyncMessage {
  type: SyncMessageType;
  payload?: unknown;
}

export interface SyncState {
  isGenerating: boolean;
  qrDataUrl: string | null;
  plaintextToken: string | null;
  isScanning: boolean;
  scanError: string | null;
  isConnecting: boolean;
  isSyncing: boolean;
  syncProgress: number;
  syncError: string | null;
  isComplete: boolean;
}

export const syncState = $state<SyncState>({
  isGenerating: false,
  qrDataUrl: null,
  plaintextToken: null,
  isScanning: false,
  scanError: null,
  isConnecting: false,
  isSyncing: false,
  syncProgress: 0,
  syncError: null,
  isComplete: false,
});

let _transport: PeerTransport | null = null;
let _html5QrCode: Html5Qrcode | null = null;
let _syncRoomCode: string | null = null;
let _syncToken: string | null = null;
let _syncExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let _isSourceDevice = false;
// Target-side: the one source peer we're syncing with. Once set, data from any
// other peer that joined the (ephemeral) sync room is ignored — otherwise a
// second joiner could inject a forged database/identity export.
let _targetSourcePeerId: string | null = null;

/** Reduce a full or short-code token to its comparable 8-char prefix. */
function tokenPrefix(t: string | undefined | null): string {
  return (t ?? "").slice(0, 8);
}

const SYNC_ROOM_PREFIX = "__sync_";
const SYNC_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 50;

function encode(data: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data));
}

function decode(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

function generateSyncRoomCode(): string {
  // Generate 8 random hex chars = 4.3 billion combinations, plenty for ephemeral sync
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));
  const random = Array.from(randomBytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${SYNC_ROOM_PREFIX}${random}`;
}

function generateToken(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a short readable code from full room code and token
 * Uses base32-like encoding for shorter, readable codes
 */
function generateShortCode(roomCode: string, token: string): string {
  // Remove prefix from room code and take first 8 chars of each
  const roomPart = roomCode.slice(SYNC_ROOM_PREFIX.length).slice(0, 8);
  const tokenPart = token.slice(0, 8);

  // Format: XXXX-XXXX (8 chars room + 8 chars token)
  return `${roomPart}-${tokenPart}`;
}

/**
 * Parse short code back to full payload
 */
function parseShortCode(
  shortCode: string
): { roomCode: string; token: string } | null {
  const parts = shortCode.split("-");
  if (parts.length !== 2) return null;

  const [roomPart, tokenPart] = parts;
  if (roomPart.length !== 8 || tokenPart.length !== 8) return null;

  // Reconstruct the full room code (we lose the middle part but that's ok for sync rooms)
  return {
    roomCode: `${SYNC_ROOM_PREFIX}${roomPart}`,
    token: tokenPart,
  };
}

/**
 * Generate a sync QR code and plaintext token for the source device.
 * Call this when you want to sync FROM this device TO another.
 */
export async function generateSyncCode(): Promise<void> {
  syncState.isGenerating = true;
  syncState.qrDataUrl = null;
  syncState.plaintextToken = null;
  syncState.syncError = null;

  try {
    _syncRoomCode = generateSyncRoomCode();
    const token = generateToken();
    _syncToken = token;
    const expires = Date.now() + SYNC_TIMEOUT;

    // Enforce expiry on the SOURCE: the QR/short code's own `expires` field
    // is attacker-controlled (and re-synthesized for manual codes), so the
    // only reliable expiry is tearing the server down ourselves.
    if (_syncExpiryTimer) clearTimeout(_syncExpiryTimer);
    _syncExpiryTimer = setTimeout(() => {
      if (!syncState.isSyncing && !syncState.isComplete) {
        syncState.syncError = "Sync code expired";
        cleanup().catch(() => {});
      }
    }, SYNC_TIMEOUT);

    const payload: SyncPayload = {
      roomCode: _syncRoomCode,
      token,
      expires,
    };

    const payloadJson = JSON.stringify(payload);

    // Generate QR code
    const qrDataUrl = await QRCode.toDataURL(payloadJson, {
      width: 256,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });

    // Create short plaintext token
    const plaintextToken = generateShortCode(_syncRoomCode, token);

    syncState.qrDataUrl = qrDataUrl;
    syncState.plaintextToken = plaintextToken;
    _isSourceDevice = true;

    // Start listening for connections
    await startSyncServer();
  } catch (err) {
    syncState.syncError = err instanceof Error ? err.message : String(err);
  } finally {
    syncState.isGenerating = false;
  }
}

/**
 * Parse a plaintext token and return the full payload.
 * Supports both formats:
 *   Short: XXXXXXXX-XXXXXXXX (roomPart-tokenPart)
 *   Full:  __sync_xxxxxxxxxxxxxxxx:token (for QR code JSON)
 */
export function parsePlaintextToken(plaintext: string): SyncPayload | null {
  // Try short format first (contains hyphen but no __sync_ prefix)
  if (plaintext.includes("-") && !plaintext.includes(SYNC_ROOM_PREFIX)) {
    const parsed = parseShortCode(plaintext);
    if (parsed) {
      return {
        roomCode: parsed.roomCode,
        token: parsed.token,
        expires: Date.now() + SYNC_TIMEOUT,
      };
    }
  }

  // Try full format (contains colon)
  const lastColon = plaintext.lastIndexOf(":");
  if (lastColon !== -1) {
    const roomCode = plaintext.slice(0, lastColon);
    const token = plaintext.slice(lastColon + 1);

    // Validate the room code has the correct prefix
    if (roomCode.startsWith(SYNC_ROOM_PREFIX)) {
      return {
        roomCode,
        token,
        expires: Date.now() + SYNC_TIMEOUT,
      };
    }
  }

  return null;
}

/**
 * Start the sync server on the source device.
 * Source waits for target to connect, then target sends ExportRequest,
 * and source responds with data.
 */
async function startSyncServer(): Promise<void> {
  if (!_syncRoomCode) return;

  console.log("[Sync][Source] Starting sync server for room:", _syncRoomCode);

  _transport = new LibP2PTransport();

  // Set up handlers
  _transport.on("connect", (peerId: string) => {
    console.log("[Sync][Source] Peer connected:", peerId.slice(0, 8));
    syncState.isConnecting = false;
    syncState.isSyncing = true;
  });

  _transport.on("disconnect", () => {
    console.log("[Sync][Source] Peer disconnected");
    if (!syncState.isComplete) {
      syncState.syncError = "Connection lost";
    }
  });

  // Source handles requests from target
  _transport.on("message", async (peerId: string, data: Uint8Array) => {
    console.log("[Sync][Source] Received message from:", peerId.slice(0, 8));
    try {
      const msg = decode(data) as SyncMessage;
      console.log("[Sync][Source] Message type:", msg.type);

      if (msg.type === SyncMessageType.ExportRequest) {
        const { mode, token } = (msg.payload ?? {}) as {
          mode?: "add" | "replace";
          token?: string;
        };

        // The room code alone is only 32 bits of entropy — the token from
        // the QR/short code is the actual proof the requester scanned it.
        // Short codes truncate the token to its first 8 chars, so accept
        // either the full token or that prefix.
        const tokenOk =
          !!_syncToken &&
          !!token &&
          (token === _syncToken || token === _syncToken.slice(0, 8));
        if (!tokenOk) {
          console.warn("[Sync][Source] Rejected ExportRequest: bad token");
          _transport?.send(
            peerId,
            encode({
              type: SyncMessageType.SyncError,
              payload: {
                error:
                  "Sync token mismatch — refresh/update the app on both devices and generate a new code",
              },
            })
          );
          return;
        }

        const requestMode = mode ?? "replace";
        console.log(
          `[Sync][Source] Received ExportRequest, mode: ${requestMode}, sending data...`
        );
        await sendExportData(peerId, requestMode);
      } else if (msg.type === SyncMessageType.ExportAck) {
        // Target acknowledged receipt (can be used for flow control)
        console.log("[Sync][Source] Received acknowledgment");
      } else if (msg.type === SyncMessageType.ExportComplete) {
        syncState.isSyncing = false;
        syncState.isComplete = true;
        await cleanup();
      } else if (msg.type === SyncMessageType.SyncError) {
        syncState.syncError = (msg.payload as { error: string }).error;
        await cleanup();
      }
    } catch (err) {
      console.error("[Sync][Source] Error handling message:", err);
    }
  });

  syncState.isConnecting = true;
  console.log("[Sync][Source] Connecting to room...");
  await _transport.connect();
  _transport.joinRoom(_syncRoomCode);
  console.log("[Sync][Source] Connected to room");
}

/**
 * Send exported database data to the target device in batches.
 */
async function sendExportData(
  peerId: string,
  mode: "add" | "replace" = "replace"
): Promise<void> {
  if (!_transport) return;

  console.log(`[Sync][Source] Exporting data in ${mode} mode`);

  try {
    // In "add" mode, we skip identity export since target keeps its own
    const exportData = await exportDatabase(mode === "add");

    // Echo the proof-of-scan token in every data frame so the target can
    // reject data from a peer that never proved it holds the shared secret.
    const token = _syncToken ?? undefined;

    // Send identity first
    _transport.send(
      peerId,
      encode({
        type: SyncMessageType.ExportData,
        payload: { section: "identity", data: exportData.identity, token },
      })
    );

    syncState.syncProgress = 10;

    // Send messages in batches with rate limiting
    const sections = [
      { name: "messages" as const, data: exportData.messages },
      { name: "attachments" as const, data: exportData.attachments },
      { name: "rooms" as const, data: exportData.rooms },
      { name: "profiles" as const, data: exportData.profiles },
      { name: "watermarks" as const, data: exportData.watermarks },
      { name: "yjsDocs" as const, data: exportData.yjsDocs },
      { name: "savedGifs" as const, data: exportData.savedGifs },
      { name: "pending" as const, data: exportData.pending },
    ];

    let processed = 0;
    for (const section of sections) {
      const batches = Math.ceil(section.data.length / BATCH_SIZE);
      console.log(
        `[Sync][Source] Sending ${section.name}: ${section.data.length} items in ${batches} batches`
      );

      for (let i = 0; i < batches; i++) {
        const batch = section.data.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        _transport.send(
          peerId,
          encode({
            type: SyncMessageType.ExportData,
            payload: {
              section: section.name,
              batchIndex: i,
              totalBatches: batches,
              data: batch,
              token,
            },
          })
        );

        // Small delay between batches to prevent overwhelming the target
        if (i < batches - 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      processed++;
      syncState.syncProgress =
        10 + Math.floor((processed / sections.length) * 80);
      console.log(
        `[Sync][Source] Sent ${section.name}: ${Math.round(syncState.syncProgress)}%`
      );
    }

    console.log("[Sync][Source] Sending ExportComplete");
    // Send completion
    _transport.send(peerId, encode({ type: SyncMessageType.ExportComplete }));

    // Don't set to 100% here - wait for target's acknowledgment
    console.log("[Sync][Source] Waiting for target to finish importing...");
  } catch (err) {
    console.error("[Sync] Error sending export data:", err);
    _transport.send(
      peerId,
      encode({
        type: SyncMessageType.SyncError,
        payload: { error: String(err) },
      })
    );
  }
}

/**
 * Connect to a sync room as the target device (receiving data).
 * Call this after scanning a QR code or entering plaintext.
 */
export async function connectAsTarget(payload: SyncPayload): Promise<void> {
  if (payload.expires < Date.now()) {
    throw new Error("Sync code has expired");
  }

  const mode = payload.mode ?? "replace";
  console.log(
    `[Sync][Target] Starting sync client for room: ${payload.roomCode}, mode: ${mode}`
  );

  syncState.isConnecting = true;
  syncState.syncError = null;

  try {
    _syncRoomCode = payload.roomCode;
    _isSourceDevice = false;

    _transport = new LibP2PTransport();

    let receivedIdentity: DatabaseExport["identity"] | null = null;
    const receivedData: Partial<DatabaseExport> = {};

    // Target sends ExportRequest after connecting
    _transport.on("connect", (peerId: string) => {
      // Pin to the first source peer. Ignore any additional peer that joins
      // this ephemeral room so it can't hand us a forged export.
      if (_targetSourcePeerId && _targetSourcePeerId !== peerId) {
        console.warn(
          "[Sync][Target] Ignoring extra peer in sync room:",
          peerId.slice(0, 8)
        );
        return;
      }
      _targetSourcePeerId = peerId;
      console.log("[Sync][Target] Connected to source:", peerId.slice(0, 8));
      syncState.isConnecting = false;
      syncState.isSyncing = true;

      // Request data from source with mode + proof-of-scan token
      _transport?.send(
        peerId,
        encode({
          type: SyncMessageType.ExportRequest,
          payload: { mode, token: payload.token },
        })
      );
    });

    _transport.on("disconnect", () => {
      console.log("[Sync][Target] Disconnected from source");
      if (!syncState.isComplete) {
        syncState.syncError = "Connection lost";
      }
    });

    _transport.on("message", async (peerId: string, data: Uint8Array) => {
      // Only accept sync traffic from the pinned source peer.
      if (_targetSourcePeerId && peerId !== _targetSourcePeerId) {
        console.warn(
          "[Sync][Target] Dropping message from non-source peer:",
          peerId.slice(0, 8)
        );
        return;
      }
      console.log("[Sync][Target] Received message from:", peerId.slice(0, 8));
      try {
        const msg = decode(data) as SyncMessage;
        console.log("[Sync][Target] Message type:", msg.type);

        if (msg.type === SyncMessageType.ExportData) {
          const {
            section,
            data: sectionData,
            batchIndex,
            totalBatches,
            token: echoedToken,
          } = msg.payload as {
            section: string;
            data: unknown;
            batchIndex?: number;
            totalBatches?: number;
            token?: string;
          };

          // The source must echo the proof-of-scan token. A peer that never
          // saw the QR/short code can't produce it, so its data is dropped.
          if (tokenPrefix(echoedToken) !== tokenPrefix(payload.token)) {
            console.warn("[Sync][Target] Dropping ExportData: token mismatch");
            return;
          }

          if (section === "identity") {
            receivedIdentity = sectionData as DatabaseExport["identity"];
            syncState.syncProgress = 10;
          } else {
            const key = section as keyof DatabaseExport;
            if (!receivedData[key]) {
              (receivedData as Record<string, unknown[]>)[key] = [];
            }
            const arr = (receivedData as Record<string, unknown[]>)[key];
            if (Array.isArray(sectionData)) {
              arr.push(...sectionData);
            }

            // Update progress
            const sections = [
              "messages",
              "attachments",
              "rooms",
              "profiles",
              "watermarks",
              "yjsDocs",
              "savedGifs",
              "pending",
            ];
            const sectionIndex = sections.indexOf(section);
            if (
              sectionIndex >= 0 &&
              batchIndex !== undefined &&
              totalBatches !== undefined
            ) {
              const sectionProgress = (batchIndex + 1) / totalBatches;
              syncState.syncProgress =
                10 +
                Math.floor(
                  ((sectionIndex + sectionProgress) / sections.length) * 80
                );
            }
          }

          // Send acknowledgment
          _transport?.send(peerId, encode({ type: SyncMessageType.ExportAck }));
        } else if (msg.type === SyncMessageType.ExportComplete) {
          console.log(
            "[Sync][Target] Received ExportComplete, importing data..."
          );
          // Import all received data
          if (receivedIdentity || mode === "add") {
            try {
              await importDatabase(
                {
                  identity: receivedIdentity || undefined,
                  messages: (receivedData.messages || []) as Message[],
                  attachments: (receivedData.attachments ||
                    []) as AttachmentExport[],
                  pending: (receivedData.pending || []) as PendingMessage[],
                  watermarks: (receivedData.watermarks ||
                    []) as WatermarkRecord[],
                  yjsDocs: (receivedData.yjsDocs || []) as {
                    id: string;
                    update: number[];
                  }[],
                  rooms: (receivedData.rooms || []) as (Room | DMRoom)[],
                  profiles: (receivedData.profiles || []) as (
                    | PeerProfile
                    | OwnProfile
                  )[],
                  savedGifs: (receivedData.savedGifs || []) as SavedGif[],
                },
                mode
              );

              console.log(
                "[Sync][Target] Import complete, sending acknowledgment"
              );
              // Send acknowledgment back to source
              _transport?.send(
                peerId,
                encode({ type: SyncMessageType.ExportComplete })
              );

              syncState.isSyncing = false;
              syncState.isComplete = true;
              syncState.syncProgress = 100;
              await cleanup();
            } catch (err) {
              console.error("[Sync][Target] Import failed:", err);
              syncState.syncError =
                err instanceof Error ? err.message : "Import failed";
              _transport?.send(
                peerId,
                encode({
                  type: SyncMessageType.SyncError,
                  payload: { error: String(err) },
                })
              );
            }
          } else {
            syncState.syncError = "No identity data received";
          }
        } else if (msg.type === SyncMessageType.SyncError) {
          syncState.syncError = (msg.payload as { error: string }).error;
          await cleanup();
        }
      } catch (err) {
        console.error("[Sync] Error handling message:", err);
        syncState.syncError = err instanceof Error ? err.message : String(err);
      }
    });

    await _transport.connect();
    _transport.joinRoom(payload.roomCode);
  } catch (err) {
    syncState.isConnecting = false;
    syncState.syncError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Export all database content.
 * If skipIdentity is true, returns empty identity (for "add" mode where target keeps its identity)
 */
async function exportDatabase(skipIdentity = false): Promise<DatabaseExport> {
  const db = await getDB();

  const [mnemonicRaw, keypairRaw] = await Promise.all([
    db.get("identity", "mnemonic"),
    db.get("identity", "keypair"),
  ]);

  const mnemonic = mnemonicRaw as {
    salt: Uint8Array;
    iv: Uint8Array;
    encrypted: ArrayBuffer;
  };
  const keypair = keypairRaw as { did: string; publicKey: Uint8Array };

  let identity: DatabaseExport["identity"] | null = null;

  if (!skipIdentity) {
    identity = {
      mnemonic: {
        salt: Array.from(new Uint8Array(mnemonic.salt)),
        iv: Array.from(new Uint8Array(mnemonic.iv)),
        encrypted: Array.from(new Uint8Array(mnemonic.encrypted)),
      },
      keypair: {
        did: keypair.did,
        publicKey: Array.from(new Uint8Array(keypair.publicKey)),
      },
    };
  }

  const [
    messages,
    attachments,
    pending,
    watermarks,
    yjsDocs,
    rooms,
    profiles,
    savedGifs,
  ] = await Promise.all([
    db.getAll("messages"),
    db.getAll("attachments"),
    db.getAll("pending"),
    db.getAll("watermarks"),
    db.getAll("yjsDocs"),
    db.getAll("rooms"),
    db.getAll("profiles"),
    db.getAll("savedGifs"),
  ]);

  const result: DatabaseExport = {
    messages,
    attachments: (attachments as Attachment[]).map((a) => ({
      ...a,
      data: a.data ? Array.from(new Uint8Array(a.data)) : undefined,
    })),
    pending,
    watermarks,
    yjsDocs: (yjsDocs as { id: string; update: Uint8Array }[]).map((doc) => ({
      id: doc.id,
      update: Array.from(doc.update),
    })),
    rooms: (rooms as (Room | DMRoom)[]).map(pfpToJson),
    profiles: (profiles as (PeerProfile | OwnProfile)[]).map(pfpToJson),
    savedGifs,
  };

  if (identity) {
    result.identity = identity;
  }

  return result;
}

/**
 * Import database content from export.
 * @param mode - "replace" wipes database first, "add" merges data
 */
async function importDatabase(
  data: DatabaseExport,
  mode: "add" | "replace" = "replace"
): Promise<void> {
  console.log(`[Sync] Importing database in ${mode} mode`);

  if (mode === "replace") {
    // Clear existing data first
    console.log("[Sync] Wiping local database (replace mode)");
    await wipeLocalDatabase();
  }

  // Import identity only if provided (not provided in "add" mode)
  if (data.identity) {
    console.log("[Sync] Importing identity");
    const mnemonicRecord = {
      id: "mnemonic" as const,
      salt: new Uint8Array(data.identity.mnemonic.salt),
      iv: new Uint8Array(data.identity.mnemonic.iv),
      encrypted: new Uint8Array(data.identity.mnemonic.encrypted).buffer,
    };

    const keypairRecord = {
      id: "keypair" as const,
      did: data.identity.keypair.did,
      publicKey: new Uint8Array(data.identity.keypair.publicKey),
    };

    await putIdentityRecord(mnemonicRecord);
    await putIdentityRecord(keypairRecord);
  }

  // Import other data
  console.log(
    `[Sync] Importing ${data.messages.length} messages, ${data.rooms.length} rooms, etc.`
  );
  await Promise.all([
    ...data.messages.map((m) => putMessage(m)),
    ...data.attachments.map((a) =>
      putAttachment({
        ...a,
        data: a.data ? new Uint8Array(a.data).buffer : undefined,
      } as Attachment)
    ),
    ...data.rooms.map((r) => putRoom(pfpFromJson(r))),
    ...data.profiles.map((raw) => {
      const p = pfpFromJson(raw);
      if (p.isMe) {
        return putOwnProfile(p as OwnProfile);
      } else {
        return putPeerProfile(p as PeerProfile);
      }
    }),
    ...data.savedGifs.map((g) => putSavedGif(g)),
    ...data.pending.map((p) => {
      return (async () => {
        const db = await getDB();
        await db.put("pending", p);
      })();
    }),
    ...data.watermarks.map((w) => {
      return (async () => {
        const db = await getDB();
        await db.put("watermarks", w);
      })();
    }),
    ...data.yjsDocs.map((doc) => {
      return (async () => {
        const db = await getDB();
        await db.put("yjsDocs", {
          id: doc.id,
          update: new Uint8Array(doc.update),
        });
      })();
    }),
  ]);
}

// ── File backup (QR-less alternative to device sync) ─────────────────────────

/**
 * Build a full backup and hand it to the browser as a download.
 * Includes the identity record, which is the AES-GCM encrypted mnemonic - the
 * file is only as safe as the password that encrypts it, so the UI warns.
 */
export async function downloadBackup(): Promise<void> {
  const data = await exportDatabase(false);
  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    ...data,
  };
  const blob = new Blob([JSON.stringify(backup)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `awful-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has taken the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Parse and validate a backup file chosen by the user.
 * @throws if the file is not a backup this build understands.
 */
export async function readBackupFile(file: File): Promise<BackupFile> {
  return parseBackup(await file.text());
}

/**
 * Apply a parsed backup.
 * "add" merges into the current identity; "replace" wipes local data first and
 * adopts the identity stored in the file (you then unlock with the password
 * that was in use when the backup was taken).
 */
export async function applyBackup(
  data: BackupFile,
  mode: "add" | "replace"
): Promise<void> {
  if (mode === "replace" && !data.identity) {
    throw new Error("This backup has no identity, so it cannot replace yours");
  }
  await importDatabase(
    mode === "add" ? { ...data, identity: undefined } : data,
    mode
  );
}

/**
 * Start camera scanning for QR codes.
 */
export async function startScanning(
  elementId: string,
  onScan: (payload: SyncPayload) => void,
  onError: (error: string) => void
): Promise<void> {
  syncState.isScanning = true;
  syncState.scanError = null;

  try {
    _html5QrCode = new Html5Qrcode(elementId);

    await _html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
      },
      (decodedText) => {
        try {
          const payload = JSON.parse(decodedText) as SyncPayload;
          if (payload.roomCode && payload.token && payload.expires) {
            stopScanning();
            onScan(payload);
          } else {
            onError("Invalid QR code format");
          }
        } catch {
          onError("Invalid QR code");
        }
      },
      () => {
        // Scan error - usually just means no QR code in frame, ignore
      }
    );
  } catch (err) {
    syncState.scanError = err instanceof Error ? err.message : String(err);
    onError(syncState.scanError);
  }
}

/**
 * Stop camera scanning.
 */
export async function stopScanning(): Promise<void> {
  if (_html5QrCode) {
    try {
      await _html5QrCode.stop();
    } catch {
      // Ignore stop errors
    }
    _html5QrCode = null;
  }
  syncState.isScanning = false;
}

/**
 * Reset sync state.
 */
export function resetSyncState(): void {
  syncState.isGenerating = false;
  syncState.qrDataUrl = null;
  syncState.plaintextToken = null;
  syncState.isScanning = false;
  syncState.scanError = null;
  syncState.isConnecting = false;
  syncState.isSyncing = false;
  syncState.syncProgress = 0;
  syncState.syncError = null;
  syncState.isComplete = false;
}

/**
 * Clean up resources.
 */
async function cleanup(): Promise<void> {
  if (_transport) {
    _transport.disconnect();
    _transport = null;
  }
  await stopScanning();
  if (_syncExpiryTimer) {
    clearTimeout(_syncExpiryTimer);
    _syncExpiryTimer = null;
  }
  _syncRoomCode = null;
  _syncToken = null;
  _isSourceDevice = false;
  _targetSourcePeerId = null;
}

/**
 * Cancel/abort current sync operation.
 */
export async function cancelSync(): Promise<void> {
  await cleanup();
  resetSyncState();
}
