import { deleteDB, openDB, type IDBPDatabase } from "idb";

import {
  sealRow,
  openRow,
  openRows,
  isSealed,
  isStorageLockedError,
  rowHasBytes,
  storageCryptoReady,
  STORE_SPECS,
  type EncryptedStoreName,
} from "./storage-crypto";
import type {
  Attachment,
  AttachmentStatus,
  FileEntry,
  Message,
  MessageStatus,
  PendingMessage,
} from "./types/message";
import { MessageType } from "./types/message";
import type {
  KeypairRecord,
  MnemonicRecord,
  WebAuthnRecord,
} from "./identity/identity";

export type RoomType = "text" | "dm";

export interface Room {
  roomCode: string;
  type: RoomType;
  name: string;
  lastSeenLamport: number; // unread count = messages with lamport > this
  createdAt: number;
  pfpData?: ArrayBuffer; // local upload - blobURL generated at runtime, never stored
  pfpURL?: string; // external URL (tenor, giphy, etc) - stored as-is
  participants: string[]; // DIDs of users in the room (stable identity)
  participantLastSeen?: Record<string, number>; // DID -> timestamp of last seen
}

const PARTICIPANT_INACTIVE_DAYS = 7;
const PARTICIPANT_INACTIVE_MS = PARTICIPANT_INACTIVE_DAYS * 24 * 60 * 60 * 1000;

export interface DMRoom extends Room {
  type: "dm";
  participantDid: string;
}

export interface OwnProfile {
  did: string; // PK - the local identity DID
  isMe: true;
  nickname: string;
  pfpData?: ArrayBuffer; // local upload
  pfpURL?: string; // external URL - stored as-is
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color?: string;
  bannerData?: ArrayBuffer; // local upload
  bannerURL?: string; // external URL
  tagText?: string; // 2-5 chars
  tagTextColor?: string; // hex like "#aabbcc"
  tagChipColor?: string; // hex like "#aabbcc"
  bio?: string; // max 200 chars
  nameEffect?: string; // none | gradient | shimmer | glow | rainbow
  /** Extra gradient stops for the "gradient" name effect. */
  gradient2?: string;
  gradient3?: string;
  updatedAt: number;
}

export interface PeerProfile {
  did: string; // PK
  isMe: false;
  nickname: string;
  pfpData?: ArrayBuffer;
  pfpURL?: string;
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color?: string;
  bannerData?: ArrayBuffer; // local upload
  bannerURL?: string; // external URL
  tagText?: string; // 2-5 chars
  tagTextColor?: string; // hex like "#aabbcc"
  tagChipColor?: string; // hex like "#aabbcc"
  bio?: string; // max 200 chars
  nameEffect?: string; // none | gradient | shimmer | glow | rainbow
  /** Extra gradient stops for the "gradient" name effect. */
  gradient2?: string;
  gradient3?: string;
  updatedAt: number;
}

export interface WatermarkRecord {
  id: string; // "roomCode:senderId"
  roomCode: string;
  senderId: string;
  maxLamport: number;
}

export interface YjsDocRecord {
  id: string; // "channel:{roomCode}"
  update: Uint8Array;
}

export interface SavedGif {
  id: string;
  gifId: string;
  title: string;
  url: string;
  previewUrl: string;
  savedAt: number;
  /** Uploaded (webtorrent) gifs have no CDN url; the bytes live here. */
  data?: ArrayBuffer;
  mimeType?: string;
}

export interface PhonebookEntry {
  peerId: string;
  did?: string;
  nickname: string;
  addedAt: number;
  favorite?: boolean;
}

type AppDB = IDBPDatabase<{
  messages: {
    key: string;
    value: Message;
    indexes: {
      byRoom: string;
      byRoomLamport: [string, number];
      bySender: string;
    };
  };
  attachments: {
    key: string;
    value: Attachment;
    indexes: {
      byMessage: string;
      byInfoHash: string;
      byStatus: string;
    };
  };
  pending: {
    key: string;
    value: PendingMessage;
    indexes: {
      byRecipient: string;
    };
  };
  identity: {
    key: string;
    value: MnemonicRecord | KeypairRecord | WebAuthnRecord;
  };
  watermarks: {
    key: string;
    value: WatermarkRecord;
    indexes: {
      byRoom: string;
    };
  };
  yjsDocs: {
    key: string;
    value: YjsDocRecord;
  };
  rooms: {
    key: string;
    value: Room | DMRoom;
    indexes: {
      byType: string;
    };
  };
  profiles: {
    key: string;
    value: OwnProfile | PeerProfile;
  };
  savedGifs: {
    key: string;
    value: SavedGif;
  };
  phonebook: {
    key: string;
    value: PhonebookEntry;
  };
}>;

let db: AppDB | null = null;

export async function getDB(): Promise<AppDB> {
  if (db) return db;

  db = (await openDB("awful-chat", 4, {
    async upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        // messages
        const msgStore = database.createObjectStore("messages", {
          keyPath: "id",
        });
        msgStore.createIndex("byRoom", "roomCode", { unique: false });
        msgStore.createIndex("byRoomLamport", ["roomCode", "lamport"], {
          unique: false,
        });
        msgStore.createIndex("bySender", "senderId", { unique: false });

        // attachments
        const attStore = database.createObjectStore("attachments", {
          keyPath: "id",
        });
        attStore.createIndex("byMessage", "messageId", { unique: false });
        attStore.createIndex("byInfoHash", "infoHash", { unique: false });
        attStore.createIndex("byStatus", "status", { unique: false });

        // pending DM messages
        const penStore = database.createObjectStore("pending", {
          keyPath: "id",
        });
        penStore.createIndex("byRecipient", "to", { unique: false });

        // identity - keyed by "mnemonic" | "keypair"
        database.createObjectStore("identity", { keyPath: "id" });

        // watermarks - keyed by "roomCode:senderId"
        const wmStore = database.createObjectStore("watermarks", {
          keyPath: "id",
        });
        wmStore.createIndex("byRoom", "roomCode", { unique: false });

        // Yjs snapshots - keyed by "channel:{roomCode}"
        database.createObjectStore("yjsDocs", { keyPath: "id" });

        // rooms - keyed by roomCode
        const roomStore = database.createObjectStore("rooms", {
          keyPath: "roomCode",
        });
        roomStore.createIndex("byType", "type", { unique: false });

        // profiles - keyed by did for both own and peer profiles
        database.createObjectStore("profiles", { keyPath: "did" });
      }

      if (oldVersion < 2) {
        database.createObjectStore("savedGifs", { keyPath: "id" });
      }

      if (oldVersion < 3) {
        // Recreate profiles store with keyPath "did" instead of "id".
        // Peer profile data is dropped (it was broken anyway), but the user's
        // OWN profile (nickname + avatar) must survive - copy it across the
        // recreate instead of silently wiping it.
        let ownProfiles: unknown[] = [];
        if (database.objectStoreNames.contains("profiles")) {
          const all = (await transaction
            .objectStore("profiles")
            .getAll()) as unknown[];
          ownProfiles = all.filter((p) => {
            const rec = p as { isMe?: unknown; did?: unknown };
            return !!p && rec.isMe === true && typeof rec.did === "string";
          });
          database.deleteObjectStore("profiles");
        }
        const store = database.createObjectStore("profiles", {
          keyPath: "did",
        });
        for (const p of ownProfiles) store.put(p as OwnProfile);
      }

      if (oldVersion < 4) {
        database.createObjectStore("phonebook", { keyPath: "peerId" });
      }
    },
  })) as AppDB;

  return db;
}

export const PAGE_SIZE = 50;

// ── at-rest encryption boundary ──────────────────────────────────────────────
// Rows go into IDB sealed (index fields clear, everything else AES-GCM) but
// keep their compile-time types; these two casts are the only place that lie
// lives. Crypto is async and an IDB transaction auto-commits the moment a
// non-IDB await runs inside it, so every read-modify-write below reads first,
// does its crypto OUTSIDE any transaction, then writes.

async function _seal<T extends object>(
  store: EncryptedStoreName,
  record: T
): Promise<T> {
  return (await sealRow(
    record as unknown as Record<string, unknown>,
    STORE_SPECS[store]
  )) as unknown as T;
}

async function _open<T>(
  store: EncryptedStoreName,
  row: T | undefined
): Promise<T | undefined> {
  if (row === undefined) return undefined;
  try {
    return await openRow<T>(row, STORE_SPECS[store]);
  } catch (err) {
    if (isStorageLockedError(err)) throw err; // too-early read: stay loud
    // One undecryptable row (truncated blob, foreign key) degrades to one
    // missing row, never to a thrown query.
    console.warn(`[storage] dropped undecryptable ${store} row:`, err);
    return undefined;
  }
}

async function _openAll<T>(store: EncryptedStoreName, rows: T[]): Promise<T[]> {
  return openRows<T>(rows, STORE_SPECS[store]);
}

/**
 * Load a page of messages for a room, sorted by lamport ascending.
 * Pass beforeLamport for cursor-based pagination (scroll up to load older).
 */
export async function getMessages(
  roomCode: string,
  beforeLamport?: number
): Promise<Message[]> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");

  const upper: [string, number] = [
    roomCode,
    beforeLamport ?? Number.MAX_SAFE_INTEGER,
  ];
  const lower: [string, number] = [roomCode, 0];
  const range = IDBKeyRange.bound(
    lower,
    upper,
    false,
    beforeLamport !== undefined
  );

  const results: Message[] = [];
  let cursor = await index.openCursor(range, "prev");

  while (cursor && results.length < PAGE_SIZE) {
    // Plugin updates are stored as messages but never rendered (card state
    // replays them from storage directly). Letting them fill the page meant
    // one steam-roulette library link (~40 update rows per member) pushed
    // every real message out of the newest page: a 15-day room showed only
    // today. They must not consume page slots.
    if (cursor.value.type !== MessageType.PluginUpdate) {
      results.push(cursor.value);
    }
    cursor = await cursor.continue();
  }

  // Decrypt AFTER the cursor walk - the filter above only reads clear
  // fields, and crypto inside the transaction would auto-commit it.
  return _openAll("messages", results.reverse());
}

/**
 * Just the newest message of a room - for inbox previews, where loading a
 * whole page per room adds up.
 */
export async function getLastMessage(
  roomCode: string
): Promise<Message | undefined> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, 0],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );
  const cursor = await index.openCursor(range, "prev");
  return _open("messages", cursor?.value);
}

/**
 * Next lamport for a DM room: wall-clock ms with a monotonic floor. A peer
 * whose clock runs behind must still land AFTER everything already in the
 * room, or their messages fall below the seen watermark and never show as
 * unread. Allocations are serialized per room so two quick sends cannot
 * take the same value.
 */
const _dmLamportChain = new Map<string, Promise<number>>();

export function nextDmLamport(roomCode: string, ts: number): Promise<number> {
  const prev = _dmLamportChain.get(roomCode) ?? Promise.resolve(0);
  const next = prev.then(async (lastIssued) => {
    const stored = (await getLastMessage(roomCode))?.lamport ?? 0;
    const floor = Math.max(stored, lastIssued);
    return ts > floor ? ts : floor + 1;
  });
  _dmLamportChain.set(
    roomCode,
    next.catch(() => 0)
  );
  return next;
}

/**
 * Newest message in a room from anyone but the given sender - lets read
 * acks name the peer's latest message even when the loaded page holds
 * only our own.
 */
export async function getLastMessageFrom(
  roomCode: string,
  notSenderId: string
): Promise<Message | undefined> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, 0],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );
  let cursor = await index.openCursor(range, "prev");
  while (cursor) {
    if (cursor.value.senderId !== notSenderId) {
      return _open("messages", cursor.value);
    }
    cursor = await cursor.continue();
  }
  return undefined;
}

/**
 * Fetch every message for a room with no page limit.
 * Only used for sync - do not use for display.
 */
export async function getAllMessages(roomCode: string): Promise<Message[]> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, 0],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );
  const results = await index.getAll(range);
  return _openAll("messages", results);
}

/**
 * Only the room's PluginCard messages. type is a CLEAR field, so the cursor
 * walk filters without decrypting and only the few card rows pay for
 * crypto - callers used getAllMessages for this, which decrypts the entire
 * room history and froze the UI for seconds on every rescan.
 */
export async function getPluginCardMessages(
  roomCode: string
): Promise<Message[]> {
  const database = await getDB();
  const index = database.transaction("messages").store.index("byRoom");
  const rows: Message[] = [];
  let cursor = await index.openCursor(roomCode);
  while (cursor) {
    if (cursor.value.type === MessageType.PluginCard) rows.push(cursor.value);
    cursor = await cursor.continue();
  }
  const opened = await _openAll("messages", rows);
  return opened.sort((a, b) => a.lamport - b.lamport);
}

export async function getMessage(id: string): Promise<Message | undefined> {
  const database = await getDB();
  return _open("messages", await database.get("messages", id));
}

export async function putMessage(message: Message): Promise<void> {
  const database = await getDB();
  await database.put("messages", await _seal("messages", message));
}

export async function bulkPutMessages(messages: Message[]): Promise<void> {
  const database = await getDB();
  const sealed = await Promise.all(messages.map((m) => _seal("messages", m)));
  const tx = database.transaction("messages", "readwrite");
  await Promise.all([...sealed.map((m) => tx.store.put(m)), tx.done]);
}

export async function deleteMessagesForRoom(roomCode: string): Promise<void> {
  const database = await getDB();
  const tx = database.transaction(
    ["messages", "attachments", "watermarks"],
    "readwrite"
  );
  const messagesIndex = tx.objectStore("messages").index("byRoom");
  const messages = await messagesIndex.getAll(roomCode);

  for (const message of messages) {
    const attachmentsIndex = tx.objectStore("attachments").index("byMessage");
    const attachments = await attachmentsIndex.getAll(message.id);
    for (const attachment of attachments) {
      await tx.objectStore("attachments").delete(attachment.id);
      _attachmentEpoch += 1;
    }
    await tx.objectStore("messages").delete(message.id);
  }

  // Sync watermarks go with the history: left behind, a later re-join of the
  // same code would tell peers we already hold messages we just deleted, and
  // they would never be offered again.
  const wmIndex = tx.objectStore("watermarks").index("byRoom");
  for (const wm of await wmIndex.getAll(roomCode)) {
    await tx
      .objectStore("watermarks")
      .delete(watermarkId(wm.roomCode, wm.senderId));
  }

  await tx.done;
  // The Yjs snapshot lives in its own store; a leftover one would resurrect
  // the shared doc if the same room code is ever joined again.
  await database.delete("yjsDocs", `channel:${roomCode}`).catch(() => {});
}

export async function getUnreadCount(
  roomCode: string,
  lastSeenLamport: number,
  excludeSenderId?: string
): Promise<number> {
  const database = await getDB();
  const tx = database.transaction("messages");
  const index = tx.store.index("byRoomLamport");
  const range = IDBKeyRange.bound(
    [roomCode, lastSeenLamport + 1],
    [roomCode, Number.MAX_SAFE_INTEGER]
  );

  // Reactions and plugin updates are not "new messages": a heart on an old
  // message or a plugin update must not light the unread badge with nothing
  // visible to read. The range holds only unseen messages, so materializing
  // it stays cheap.
  const messages = await index.getAll(range);
  return messages.filter(
    (m) =>
      m.type !== MessageType.Reaction &&
      m.type !== MessageType.PluginUpdate &&
      (!excludeSenderId || m.senderId !== excludeSenderId)
  ).length;
}

const MESSAGE_STATUS_RANK: Record<MessageStatus, number> = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * A read receipt for one message implies everything the same sender wrote
 * earlier in that room was read too. Acks only name the page the reader had
 * loaded, so cascade the status down the backlog. Returns the ids that
 * actually changed so callers can update in-memory copies.
 */
export async function markOwnMessagesReadUpTo(
  roomCode: string,
  senderId: string,
  lamport: number
): Promise<string[]> {
  const database = await getDB();
  // status lives inside the sealed blob, so this is a three-step cascade:
  // collect candidates by clear senderId, decrypt/filter/re-seal outside any
  // transaction, then write the changed rows back.
  const index = database
    .transaction("messages")
    .store.index("byRoomLamport");
  const range = IDBKeyRange.bound([roomCode, 0], [roomCode, lamport]);
  const candidates: Message[] = [];
  let cursor = await index.openCursor(range);
  while (cursor) {
    const v = cursor.value;
    // senderId and status are clear fields: already-read backlog is skipped
    // here without a decrypt, so a cascade costs crypto only for the rows it
    // actually changes. A sealed row without a clear status (pre-status-clear
    // layout) falls through and the post-decrypt check below decides.
    if (
      v.senderId === senderId &&
      (!v.status || MESSAGE_STATUS_RANK[v.status] < MESSAGE_STATUS_RANK.read)
    ) {
      candidates.push(v);
    }
    cursor = await cursor.continue();
  }

  const changed: Message[] = [];
  for (const row of candidates) {
    const m = (await _open("messages", row))!;
    if (!m.status || MESSAGE_STATUS_RANK[m.status] < MESSAGE_STATUS_RANK.read) {
      changed.push(await _seal("messages", { ...m, status: "read" as const }));
    }
  }
  if (!changed.length) return [];

  const tx = database.transaction("messages", "readwrite");
  const written: string[] = [];
  for (const m of changed) {
    // Skip rows deleted while the crypto ran; "read" is the max rank, so
    // overwriting a surviving row can never regress it.
    const fresh = await tx.store.get(m.id);
    if (!fresh) continue;
    await tx.store.put(m);
    written.push(m.id);
  }
  await tx.done;
  return written;
}

/** Advance a message's delivery status. Never regresses (read stays read). */
export async function updateMessageStatus(
  id: string,
  status: MessageStatus
): Promise<void> {
  const database = await getDB();
  const message = await _open<Message>(
    "messages",
    await database.get("messages", id)
  );
  if (!message) return;
  if (
    message.status &&
    MESSAGE_STATUS_RANK[message.status] >= MESSAGE_STATUS_RANK[status]
  ) {
    return;
  }
  const sealed = await _seal("messages", { ...message, status });
  // The crypto ran outside any transaction; re-check against the freshest
  // row (status is a clear field on sealed rows) so a read-cascade that
  // landed meanwhile is never regressed, and a deleted row never returns.
  const tx = database.transaction("messages", "readwrite");
  const fresh = await tx.store.get(id);
  if (
    fresh &&
    (!fresh.status ||
      MESSAGE_STATUS_RANK[fresh.status] < MESSAGE_STATUS_RANK[status])
  ) {
    await tx.store.put(sealed);
  }
  await tx.done;
}

export async function getAttachment(
  id: string
): Promise<Attachment | undefined> {
  const database = await getDB();
  return _open("attachments", await database.get("attachments", id));
}

export async function getAttachmentsByMessage(
  messageId: string
): Promise<Attachment[]> {
  const database = await getDB();
  return _openAll(
    "attachments",
    await database.getAllFromIndex("attachments", "byMessage", messageId)
  );
}

export async function getAttachmentsByInfoHash(
  infoHash: string
): Promise<Attachment[]> {
  const database = await getDB();
  return _openAll(
    "attachments",
    await database.getAllFromIndex("attachments", "byInfoHash", infoHash)
  );
}

export async function getAttachmentsWithData(
  roomCode: string
): Promise<Attachment[]> {
  const database = await getDB();
  // Select by the bytes, not the status: rows written before the status
  // rank guards could be stuck at "downloading"/"failed" WITH data present,
  // and filtering on status made those images unrenderable forever.
  // rowHasBytes sees the bytes whether the row is sealed or legacy, and the
  // filter runs BEFORE decryption so no-data rows never cost a decrypt.
  const all = await database.getAll("attachments");
  return _openAll(
    "attachments",
    all.filter((a) => a.roomCode === roomCode && rowHasBytes(a, "data"))
  );
}

/**
 * Bumped whenever the stored attachment set changes, so callers that cache a
 * derived view of it can tell theirs is stale without re-reading the store.
 */
let _attachmentEpoch = 0;
export function attachmentEpoch(): number {
  return _attachmentEpoch;
}

/**
 * Every file we still hold the bytes for, with the room it belongs to.
 *
 * Walked with a cursor rather than getAll(): the records carry the blobs, and
 * materialising all of them at once to read four small fields is how you run a
 * phone out of memory.
 */
export async function getSeedableFiles(): Promise<
  Array<{ roomCode: string; file: FileEntry }>
> {
  const database = await getDB();
  // Two passes: the cursor walk collects one small clone per infoHash using
  // only clear fields and drops the blob references, then the metadata
  // decrypt (skipBytes: filename/mimeType/size live in the JSON blob, the
  // file bytes stay sealed) happens outside the transaction.
  const byHash = new Map<string, Attachment>();
  let cursor = await database.transaction("attachments").store.openCursor();
  while (cursor) {
    const row = cursor.value;
    if (rowHasBytes(row, "data") && !byHash.has(row.infoHash)) {
      const { data: _d, ...meta } = row as Attachment & {
        _encBytes?: unknown;
      };
      delete (meta as { _encBytes?: unknown })._encBytes;
      byHash.set(row.infoHash, meta as Attachment);
    }
    cursor = await cursor.continue();
  }
  const out: Array<{ roomCode: string; file: FileEntry }> = [];
  for (const row of byHash.values()) {
    const a = await openRow<Attachment>(row, STORE_SPECS.attachments, {
      skipBytes: true,
    });
    out.push({
      roomCode: a.roomCode,
      file: {
        infoHash: a.infoHash,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      },
    });
  }
  return out;
}

export async function putAttachment(attachment: Attachment): Promise<void> {
  const database = await getDB();
  const { blobURL: _, ...record } = attachment;
  await database.put("attachments", await _seal("attachments", record));
  _attachmentEpoch += 1;
}

const ATTACHMENT_STATUS_RANK: Record<AttachmentStatus, number> = {
  pending: 0,
  downloading: 1,
  failed: 2,
  complete: 3,
  seeding: 4,
};

/** Advance an attachment's status. Late progress events must not regress it. */
export async function updateAttachmentStatus(
  id: string,
  status: AttachmentStatus
): Promise<void> {
  const database = await getDB();
  const tx = database.transaction("attachments", "readwrite");
  const attachment = await tx.store.get(id);
  if (!attachment) return;
  if (
    ATTACHMENT_STATUS_RANK[attachment.status] >= ATTACHMENT_STATUS_RANK[status]
  ) {
    return;
  }
  await tx.store.put({ ...attachment, status });
  await tx.done;
}

/**
 * Patch only the downloaded bytes onto an attachment, in one transaction.
 * A whole-record put built before the (long) blob read clobbered whatever
 * status the seeding path wrote in the meantime.
 */
export async function updateAttachmentData(
  id: string,
  data: ArrayBuffer
): Promise<void> {
  const database = await getDB();
  const attachment = await _open<Attachment>(
    "attachments",
    await database.get("attachments", id)
  );
  if (!attachment) return;
  const status =
    ATTACHMENT_STATUS_RANK[attachment.status] >=
    ATTACHMENT_STATUS_RANK.complete
      ? attachment.status
      : ("complete" as AttachmentStatus);
  const sealed = await _seal("attachments", { ...attachment, data, status });
  // The seal ran outside any transaction; status is a CLEAR field, so the
  // regression guard re-checks against the freshest row at write time - the
  // seeding path may have advanced it while we were encrypting the blob.
  const tx = database.transaction("attachments", "readwrite");
  const fresh = await tx.store.get(id);
  if (!fresh) {
    // Deleted (room wipe) while the blob was encrypting: re-inserting it
    // would leave an undeletable orphan.
    await tx.done;
    return;
  }
  if (
    ATTACHMENT_STATUS_RANK[fresh.status] > ATTACHMENT_STATUS_RANK[sealed.status]
  ) {
    sealed.status = fresh.status;
  }
  await tx.store.put(sealed);
  await tx.done;
  _attachmentEpoch += 1;
}

export async function getKeypairRecord(): Promise<KeypairRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "keypair") as Promise<
    KeypairRecord | undefined
  >;
}

export async function getMnemonicRecord(): Promise<MnemonicRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "mnemonic") as Promise<
    MnemonicRecord | undefined
  >;
}

export async function putIdentityRecord(
  record: MnemonicRecord | KeypairRecord | WebAuthnRecord
): Promise<void> {
  const database = await getDB();
  await database.put("identity", record);
}

export async function getRoom(
  roomCode: string
): Promise<Room | DMRoom | undefined> {
  const database = await getDB();
  return _open("rooms", await database.get("rooms", roomCode));
}

export async function getAllRooms(): Promise<(Room | DMRoom)[]> {
  const database = await getDB();
  return _openAll("rooms", await database.getAll("rooms"));
}

export async function getDMRooms(): Promise<DMRoom[]> {
  const database = await getDB();
  return _openAll(
    "rooms",
    (await database.getAllFromIndex("rooms", "byType", "dm")) as DMRoom[]
  );
}

export async function putRoom(room: Room | DMRoom): Promise<void> {
  const database = await getDB();
  const roomWithParticipants = {
    ...room,
    participants: room.participants ?? [],
  };
  await database.put("rooms", await _seal("rooms", roomWithParticipants));
}

/** Shared read-decrypt-modify-seal-write cycle for room records. The old
 *  single-transaction versions cannot survive at-rest crypto (an IDB tx
 *  auto-commits on any non-IDB await), so the patch runs between a read and
 *  a write; every patch below is idempotent or monotonic, which keeps the
 *  slightly wider race window harmless. */
async function _patchRoom(
  roomCode: string,
  patch: (room: Room | DMRoom) => Room | DMRoom | null
): Promise<void> {
  const database = await getDB();
  const room = await _open<Room | DMRoom>(
    "rooms",
    await database.get("rooms", roomCode)
  );
  if (!room) return;
  const updated = patch(room);
  if (!updated) return;
  await database.put("rooms", await _seal("rooms", updated));
}

export async function getRoomParticipants(roomCode: string): Promise<string[]> {
  const room = await getRoom(roomCode);
  return room?.participants ?? [];
}

export async function addRoomParticipant(
  roomCode: string,
  peerId: string
): Promise<void> {
  // participants are documented as DIDs; a raw peerId written here is never
  // matched by a leave (keyed by DID) and ghosts the member list for 7 days.
  if (!peerId.startsWith("did:")) return;
  await _patchRoom(roomCode, (room) => {
    const participants = new Set(room.participants ?? []);
    participants.add(peerId);
    const participantLastSeen = room.participantLastSeen ?? {};
    participantLastSeen[peerId] = Date.now();
    return { ...room, participants: [...participants], participantLastSeen };
  });
}

export async function updateParticipantLastSeen(
  roomCode: string,
  peerId: string
): Promise<void> {
  await _patchRoom(roomCode, (room) => {
    const participantLastSeen = room.participantLastSeen ?? {};
    participantLastSeen[peerId] = Date.now();
    return { ...room, participantLastSeen };
  });
}

export async function removeRoomParticipant(
  roomCode: string,
  peerId: string
): Promise<void> {
  await _patchRoom(roomCode, (room) => {
    const participants = new Set(room.participants ?? []);
    participants.delete(peerId);
    const participantLastSeen = room.participantLastSeen ?? {};
    delete participantLastSeen[peerId];
    return { ...room, participants: [...participants], participantLastSeen };
  });
}

export async function cleanupInactiveParticipants(
  roomCode: string
): Promise<string[]> {
  const removed: string[] = [];
  await _patchRoom(roomCode, (room) => {
    const cutoff = Date.now() - PARTICIPANT_INACTIVE_MS;
    const participantLastSeen = room.participantLastSeen ?? {};
    const participants = new Set(room.participants ?? []);
    for (const peerId of participants) {
      const lastSeen = participantLastSeen[peerId] ?? 0;
      if (lastSeen < cutoff) {
        participants.delete(peerId);
        delete participantLastSeen[peerId];
        removed.push(peerId);
      }
    }
    return { ...room, participants: [...participants], participantLastSeen };
  });
  return removed;
}

/**
 * Mark all messages up to the given lamport as seen.
 * Used to derive unread count in the sidebar.
 *
 * Monotonic: concurrent callers race while a conversation is open (the
 * incoming-message handler vs the open-conversation path working from an
 * older snapshot), and a late write with a lower lamport would resurrect
 * already-read messages as unread.
 */
export async function markRoomSeen(
  roomCode: string,
  lamport: number
): Promise<void> {
  await _patchRoom(roomCode, (room) => ({
    ...room,
    lastSeenLamport: Math.max(room.lastSeenLamport ?? 0, lamport),
  }));
}

export async function deleteRoom(roomCode: string): Promise<void> {
  const database = await getDB();
  await database.delete("rooms", roomCode);
}

export async function getOwnProfile(
  selfDid?: string
): Promise<OwnProfile | undefined> {
  const database = await getDB();
  // did and isMe are clear fields, so both lookups run before any decrypt.
  const all = await database.getAll("profiles");
  const mine = all.find((p) => p.isMe === true);
  if (mine) return _open("profiles", mine as OwnProfile);
  // Fall back to the row under our own did, and repair the flag. An incoming
  // profile used to be written over that row with isMe:false - our own second
  // device carries the same did - and the flag alone then hid a row that was
  // otherwise intact, so the app looked like it had forgotten who we are.
  if (!selfDid) return undefined;
  const byDid = all.find((p) => p.did === selfDid);
  if (!byDid) return undefined;
  const repaired = {
    ...(await _open<OwnProfile>("profiles", byDid as OwnProfile))!,
    isMe: true as const,
  };
  try {
    await database.put("profiles", await _seal("profiles", repaired));
  } catch {
    // Reading still works even if the repair write does not.
  }
  return repaired;
}

export async function putOwnProfile(profile: OwnProfile): Promise<void> {
  const database = await getDB();
  await database.put(
    "profiles",
    await _seal("profiles", { ...profile, isMe: true as const })
  );
}

/**
 * Move the own-profile row to a new key. Used to repair rows written before
 * the identity existed, which landed under an empty did.
 */
export async function rekeyOwnProfile(
  from: string,
  to: string
): Promise<void> {
  if (from === to) return;
  const database = await getDB();
  const existing = await _open<OwnProfile>(
    "profiles",
    (await database.get("profiles", from)) as OwnProfile | undefined
  );
  if (existing) {
    const sealed = await _seal("profiles", {
      ...existing,
      did: to,
      isMe: true as const,
    });
    // Crypto done; put+delete in ONE transaction so an interruption can
    // never leave two isMe rows behind.
    const tx = database.transaction("profiles", "readwrite");
    await tx.store.put(sealed);
    await tx.store.delete(from);
    await tx.done;
  }
}

/**
 * Patch own profile.
 * pfpData and pfpURL are mutually exclusive - setting one clears the other.
 */
export async function updateOwnProfile(
  patch: Partial<Pick<OwnProfile, "nickname" | "pfpData" | "pfpURL" | "color" | "bannerData" | "bannerURL" | "tagText" | "tagTextColor" | "tagChipColor" | "bio" | "nameEffect" | "gradient2" | "gradient3">>
): Promise<void> {
  const database = await getDB();
  const all = await database.getAll("profiles");
  const row = all.find((p) => p.isMe === true);
  if (!row) return;
  const profile = (await _open<OwnProfile>("profiles", row as OwnProfile))!;
  const updated: OwnProfile = { ...profile, ...patch, updatedAt: Date.now() };
  if (patch.pfpData !== undefined) updated.pfpURL = undefined;
  if (patch.pfpURL !== undefined) updated.pfpData = undefined;
  if (patch.bannerData !== undefined) updated.bannerURL = undefined;
  if (patch.bannerURL !== undefined) updated.bannerData = undefined;
  await database.put("profiles", await _seal("profiles", updated));
}

export async function getPeerProfile(
  did: string
): Promise<PeerProfile | undefined> {
  const database = await getDB();
  const record = await database.get("profiles", did);
  if (!record || record.isMe) return undefined;
  return _open("profiles", record as PeerProfile);
}

export async function putPeerProfile(profile: PeerProfile): Promise<void> {
  const database = await getDB();
  await database.put(
    "profiles",
    await _seal("profiles", { ...profile, isMe: false as const })
  );
}

export async function getAllPeerProfiles(): Promise<PeerProfile[]> {
  const database = await getDB();
  const all = await database.getAll("profiles");
  return _openAll(
    "profiles",
    all.filter((p): p is PeerProfile => p.isMe === false)
  );
}

/**
 * Generate a runtime blobURL from pfpData.
 * Use when pfpData is set and you need an <img src>.
 * Caller must call URL.revokeObjectURL() when done.
 */
export function pfpBlobURL(
  pfpData: ArrayBuffer,
  mimeType = "image/jpeg"
): string {
  return URL.createObjectURL(new Blob([pfpData], { type: mimeType }));
}

function watermarkId(roomCode: string, senderId: string): string {
  return `${roomCode}:${senderId}`;
}

export async function getWatermark(
  roomCode: string,
  senderId: string
): Promise<number> {
  const database = await getDB();
  const record = await database.get(
    "watermarks",
    watermarkId(roomCode, senderId)
  );
  return record?.maxLamport ?? 0;
}

export async function setWatermark(
  roomCode: string,
  senderId: string,
  maxLamport: number
): Promise<void> {
  const database = await getDB();
  const id = watermarkId(roomCode, senderId);
  // Read+write in ONE transaction so concurrent fire-and-forget callers can't
  // interleave and regress the watermark (a late lower value clobbering a
  // higher one written between our get and put).
  const tx = database.transaction("watermarks", "readwrite");
  const existing = await tx.store.get(id);
  // Never regress - only advance the watermark
  if (!existing || existing.maxLamport < maxLamport) {
    await tx.store.put({ id, roomCode, senderId, maxLamport });
  }
  await tx.done;
}

export async function getWatermarksForRoom(
  roomCode: string
): Promise<Record<string, number>> {
  const database = await getDB();
  const records = await database.getAllFromIndex(
    "watermarks",
    "byRoom",
    roomCode
  );
  return Object.fromEntries(records.map((r) => [r.senderId, r.maxLamport]));
}

export async function getAllSavedGifs(): Promise<SavedGif[]> {
  const database = await getDB();
  return _openAll("savedGifs", await database.getAll("savedGifs"));
}

export async function putSavedGif(gif: SavedGif): Promise<void> {
  const database = await getDB();
  await database.put("savedGifs", await _seal("savedGifs", gif));
}

export async function deleteSavedGif(id: string): Promise<void> {
  const database = await getDB();
  await database.delete("savedGifs", id);
}

export async function isGifSaved(gifId: string): Promise<SavedGif | undefined> {
  const database = await getDB();
  const all = await database.getAll("savedGifs");
  // gifId is a clear field: the lookup costs zero decrypts, only the hit.
  return _open("savedGifs", all.find((g) => g.gifId === gifId));
}

export async function getWebAuthnRecord(): Promise<WebAuthnRecord | undefined> {
  const database = await getDB();
  return database.get("identity", "webauthn") as Promise<
    WebAuthnRecord | undefined
  >;
}

export async function getPhonebookEntries(): Promise<PhonebookEntry[]> {
  const database = await getDB();
  const entries = await _openAll<PhonebookEntry>(
    "phonebook",
    await database.getAll("phonebook")
  );
  return entries.sort((a, b) => {
    const favDiff = Number(!!b.favorite) - Number(!!a.favorite);
    if (favDiff !== 0) return favDiff;
    return a.addedAt - b.addedAt;
  });
}

/**
 * Merge duplicate phonebook rows referring to one human. The store is keyed
 * by whichever identity form was known at add time, so the same contact can
 * exist once keyed by DID (added offline) and once by peerId (added online).
 * Entries with no DID at all are left alone - a peerId cannot be turned into
 * an identity DID after the fact.
 */
export async function dedupePhonebook(): Promise<void> {
  const database = await getDB();
  const entries = await _openAll<PhonebookEntry>(
    "phonebook",
    await database.getAll("phonebook")
  );
  const byDid = new Map<string, PhonebookEntry[]>();
  for (const e of entries) {
    const did =
      e.did ?? (e.peerId.startsWith("did:") ? e.peerId : undefined);
    if (!did) continue;
    const group = byDid.get(did) ?? [];
    group.push(e);
    byDid.set(did, group);
  }
  for (const [did, group] of byDid) {
    if (group.length < 2) continue;
    // Prefer the row with a real transport peerId; the union keeps the
    // earliest addedAt (sort order) and any favorite flag.
    const keeper =
      group.find((e) => !e.peerId.startsWith("did:")) ?? group[0];
    const merged: PhonebookEntry = {
      ...keeper,
      did,
      nickname: group.find((e) => e.nickname)?.nickname ?? keeper.nickname,
      addedAt: Math.min(...group.map((e) => e.addedAt)),
      favorite: group.some((e) => e.favorite) || undefined,
    };
    for (const e of group) await database.delete("phonebook", e.peerId);
    await database.put("phonebook", await _seal("phonebook", merged));
  }
}

export async function putPhonebookEntry(entry: PhonebookEntry): Promise<void> {
  const database = await getDB();
  await database.put("phonebook", await _seal("phonebook", entry));
}

export async function deletePhonebookEntry(peerId: string): Promise<void> {
  const database = await getDB();
  await database.delete("phonebook", peerId);
}

export async function deleteWebAuthnRecord(): Promise<void> {
  const database = await getDB();
  await database.delete("identity", "webauthn");
}

export async function wipeLocalDatabase(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  await deleteDB("awful-chat");
}

/** Close the cached connection without deleting anything - a
 *  deleteDatabase from elsewhere (the duress wipe) blocks forever while
 *  this module holds its handle open. */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── at-rest migration ────────────────────────────────────────────────────────

const ATREST_DONE_FLAG = "awful:atrest:v1";
let _migrationRunning = false;

/** Call after any write that may have landed plaintext (a locked import):
 *  the next unlock's sweep re-scans and seals it. */
export function markAtRestSweepNeeded(): void {
  try {
    localStorage.removeItem(ATREST_DONE_FLAG);
  } catch {
    // Without localStorage the sweep always runs anyway.
  }
}

/**
 * One-time background sweep re-encrypting rows written before at-rest
 * encryption existed. Reads pass legacy plaintext rows through, so the app
 * is fully usable while this runs; each pass converts a chunk and loops
 * until a full scan finds nothing plaintext. Chunked so no transaction
 * spans the (async, tx-killing) crypto, and so a mid-sweep close just
 * resumes next unlock.
 */
export async function migrateAtRest(): Promise<void> {
  if (_migrationRunning) return;
  try {
    if (localStorage.getItem(ATREST_DONE_FLAG)) return;
  } catch {
    // No localStorage (tests): scan anyway, it is cheap when all is sealed.
  }
  if (!storageCryptoReady()) return;
  _migrationRunning = true;
  try {
    const database = await getDB();
    let sealedCount = 0;
    for (const store of Object.keys(STORE_SPECS) as EncryptedStoreName[]) {
      // Byte-carrying stores hold multi-MB blobs per row: a 100-row chunk
      // of attachments would materialize hundreds of MB at once.
      const CHUNK = (STORE_SPECS[store] as { bytes?: string[] }).bytes?.length
        ? 8
        : 100;
      for (;;) {
        // Collect one chunk of plaintext rows (no crypto inside the tx)...
        const plain: Array<{ key: IDBValidKey; row: Record<string, unknown> }> =
          [];
        let cursor = await database.transaction(store).store.openCursor();
        while (cursor && plain.length < CHUNK) {
          if (!isSealed(cursor.value)) {
            plain.push({
              key: cursor.primaryKey,
              row: cursor.value as unknown as Record<string, unknown>,
            });
          }
          cursor = await cursor.continue();
        }
        if (plain.length === 0) break;
        // ...seal it outside, write it back conditionally. Every app write
        // seals, so a row that changed while our crypto ran is sealed by
        // now - re-checking inside the (atomic) write transaction means the
        // sweep can never clobber a live update with its stale pre-read.
        const sealed = await Promise.all(
          plain.map((p) => sealRow(p.row, STORE_SPECS[store]))
        );
        const tx = database.transaction(store, "readwrite");
        for (let i = 0; i < sealed.length; i++) {
          const fresh = await tx.store.get(plain[i].key as string);
          if (fresh && !isSealed(fresh)) {
            await tx.store.put(sealed[i] as never);
            sealedCount += 1;
          }
        }
        await tx.done;
        if (plain.length < CHUNK) break;
      }
    }
    if (sealedCount > 0) {
      console.log(`[storage] at-rest migration sealed ${sealedCount} rows`);
    }
    try {
      localStorage.setItem(ATREST_DONE_FLAG, String(Date.now()));
    } catch {
      // Flag is an optimization; the scan re-runs next unlock without it.
    }
  } finally {
    _migrationRunning = false;
  }
}

/**
 * Ask the browser to keep this origin's data out of automatic eviction.
 *
 * This app has no server copy: everything you own lives in IndexedDB here, so
 * eviction under storage pressure means losing your identity and history. Safe
 * to call repeatedly. Chrome grants it silently based on engagement/install,
 * Firefox may prompt, and unsupported browsers just report false.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

export interface StorageMetrics {
  /** True when the browser promised not to evict this origin's data. */
  persisted: boolean;
  /** Bytes the browser is willing to give this origin, when it reports one. */
  quota: number | null;
  totalMessages: number;
  totalRooms: number;
  totalProfiles: number;
  seedingAttachments: number;
  totalAttachments: number;
  storedDataSize: number;
  rooms: { name: string; messageCount: number }[];
}

export async function getStorageMetrics(): Promise<StorageMetrics> {
  const database = await getDB();

  const rooms = await _openAll<Room | DMRoom>(
    "rooms",
    await database.getAll("rooms")
  );
  const profiles = await database.getAll("profiles");
  const attachments = await database.getAll("attachments");

  const seedingCount = attachments.filter((a) => a.status === "seeding").length;

  // Ciphertext length ~= plaintext length for AES-GCM, so sealed rows report
  // their size without decrypting a single blob.
  let storedSize = 0;
  attachments.forEach((a) => {
    const enc = (a as unknown as { _encBytes?: { data?: { ct: ArrayBuffer } } })
      ._encBytes?.data;
    if (a.data) storedSize += a.data.byteLength;
    else if (enc) storedSize += enc.ct.byteLength;
  });

  const totalMessages = await database.count("messages");
  const roomCounts = new Map<string, number>();
  for (const room of rooms) {
    const count = await database.countFromIndex(
      "messages",
      "byRoomLamport",
      IDBKeyRange.bound(
        [room.roomCode, 0],
        [room.roomCode, Number.MAX_SAFE_INTEGER]
      )
    );
    roomCounts.set(room.roomCode, count);
  }

  const roomMetrics = Array.from(roomCounts.entries())
    .map(([roomCode, messageCount]) => {
      const room = rooms.find((r) => r.roomCode === roomCode);
      return {
        name: room?.name || roomCode,
        messageCount,
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 5);

  let quota: number | null = null;
  try {
    quota = (await navigator.storage?.estimate?.())?.quota ?? null;
  } catch {
    quota = null;
  }

  return {
    persisted: await isStoragePersisted(),
    quota,
    totalMessages,
    totalRooms: rooms.length,
    totalProfiles: profiles.length,
    seedingAttachments: seedingCount,
    totalAttachments: attachments.length,
    storedDataSize: storedSize,
    rooms: roomMetrics,
  };
}
