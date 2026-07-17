import { MediasoupVideo } from "./mediasoup";
import { identityStore } from "../identity/identity.svelte";
import {
  getOwnProfile,
  putMessage,
  bulkPutMessages,
  getMessages,
  getAllMessages,
  getWatermarksForRoom,
  setWatermark,
  markRoomSeen,
  getPeerProfile,
  putPeerProfile,
  getAllPeerProfiles,
  putAttachment,
  getAttachmentsByMessage,
  updateMessageStatus,
  getRoomParticipants,
  addRoomParticipant,
  removeRoomParticipant,
  updateParticipantLastSeen,
  cleanupInactiveParticipants,
} from "../storage";
import {
  MessageType,
  wireToMessage,
  messageToWire,
  type Message,
  type ChatMessageType,
  type AnyWireMessage,
  type WireChatMessage,
  type WireProfile,
  type WireCallState,
  type FileEntry,
  type FileMeta,
  type Attachment,
} from "../types/message";
import {
  refreshUnreadCount,
  refreshDmRooms,
  roomsStore,
} from "../rooms.svelte";
import { WebTorrentFileTransport } from "./file/webtorrent";
import type { FileDescriptor, FileTransferSnapshot } from "./types";
import { LibP2PTransport } from "./libp2p/transport";
import { LibP2PVoice } from "./libp2p/voice";
import { DtlnProcessor } from "../audio/dtln-processor";
import { requireSession } from "../identity/identity";
import { canonicalFor, signMessage, verifySignature } from "../messaging";
import { encode, decode, normalizeAvatarUrl } from "../utils";
import { _sendCallPresence, _sendCallState, leaveCall } from "./call.svelte";
import {
  encodeDmAckEnvelope,
  encodeDmReadEnvelope,
  parseDmEnvelope,
} from "./dm-codec";
import {
  ensureDmRoomForPeer,
  flushQueuedDmForPeer,
  joinPhonebookDmRooms,
  resolveDmDisplayName,
  sendDirectMessage,
} from "./dm.svelte";
import {
  _hydrateFileTransfersFromStorage,
  _resumeAttachmentSeeding,
  fileFingerprint,
  initFiles,
  isFileSignalWireMessage,
  maybePeerIdFromSenderId,
  shouldAutoDownload,
  withFileTransfer,
} from "./files.svelte";
import { initVoice } from "./voice.svelte";
import { initTransmission } from "./transmission.svelte";

export type { Message };

// ── State shapes ──────────────────────────────────────────────────────────────

interface SendMessageOptions {
  replyTo?: Message["replyTo"];
  type?: ChatMessageType;
  meta?: FileMeta;
  attachments?: string[];
  reactionTo?: string;
  reactionEmoji?: string;
  reactionOp?: "add" | "remove";
}

export interface ParticipantState {
  peerId: string;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
}

interface TransportState {
  relayConnected: boolean;
  connected: boolean;
  connecting: boolean;
  roomCode: string | null;
  roomName: string;
  peers: string[];
  roomUsers: string[];
  messages: Message[];
  inCall: boolean;
  muted: boolean;
  deafened: boolean;
  participants: Map<string, ParticipantState>;
  localCameraStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  localMicStream: MediaStream | null;
  cameraOff: boolean;
  screenSharing: boolean;
  peerNames: Map<string, string>;
  peerAvatars: Map<string, string>;
  error: string | null;
  callPeerIds: Set<string>;
  callPeerRooms: Map<string, string>; // peerId -> roomCode they're calling in
  sfuPeerIds: Set<string>;
  pendingTransmissions: Map<string, string>;
  watchingTransmissionPeerId: string | null;
  watchingTransmissionProducerId: string | null;
  transmissionOutputVolume: number;
  fileTransfers: Map<string, FileTransferSnapshot>;
  callPeerStates: Map<string, { muted: boolean; deafened: boolean }>;
  chatMode: "room" | "dm";
  activeDmPeerId: string | null;
  dmVersion: number;
  callRoomCode: string | null;
}

export const transportState = $state<TransportState>({
  relayConnected: false,
  connected: false,
  connecting: false,
  roomCode: null,
  roomName: "",
  peers: [],
  roomUsers: [],
  messages: [],
  inCall: false,
  muted: false,
  deafened: false,
  participants: new Map(),
  localCameraStream: null,
  localScreenStream: null,
  localMicStream: null,
  cameraOff: true,
  screenSharing: false,
  peerNames: new Map(),
  peerAvatars: new Map(),
  error: null,
  callPeerIds: new Set(),
  callPeerRooms: new Map(),
  sfuPeerIds: new Set(),
  pendingTransmissions: new Map(),
  watchingTransmissionPeerId: null,
  watchingTransmissionProducerId: null,
  transmissionOutputVolume: 1,
  fileTransfers: new Map(),
  callPeerStates: new Map(),
  chatMode: "room",
  activeDmPeerId: null,
  dmVersion: 0,
  callRoomCode: null,
});

let _lamport = 0;
let _connectPromise: Promise<void> | null = null;

const BATCH_SIZE = 20;
export const MAX_PERSISTED_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const _peerIdToDid = new Map<string, string>();
const _seededByFingerprint = new Map<string, FileDescriptor>();

export const _dtln = new DtlnProcessor();
_dtln.init().catch(console.error);
export const _transport = new LibP2PTransport();
export const _voice = new LibP2PVoice(_transport, _dtln);
export const _video = new MediasoupVideo();
export const _fileTransport = new WebTorrentFileTransport(() =>
  _transport.selfId()
);

// Initialize submodules that depend on transport instances
// Order matters: they receive instances from here
initVoice(_voice, _dtln);
initTransmission(_video);
initFiles(_fileTransport);

const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3 } as const;

/**
 * Advance a message's delivery status (never regress: a late "delivered"
 * ack must not overwrite "read"). Updates IDB and the in-memory list.
 */
export function applyMessageStatus(
  messageId: string,
  status: keyof typeof STATUS_RANK
): void {
  updateMessageStatus(messageId, status).catch(() => {});
  const idx = transportState.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  const current = transportState.messages[idx].status;
  if (current && STATUS_RANK[current] >= STATUS_RANK[status]) return;
  const next = [...transportState.messages];
  next[idx] = { ...next[idx], status };
  transportState.messages = next;
}

function lamportSend(): number {
  _lamport += 1;
  return _lamport;
}

function lamportReceive(remote: number): void {
  _lamport = Math.max(_lamport, remote) + 1;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const transfer of transportState.fileTransfers.values()) {
      if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
    }
  });
}

// ── Senders ───────────────────────────────────────────────────────────────────

function _sendRoomName(peerId?: string): void {
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name) return;
  const payload = encode({ type: MessageType.RoomName, name });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, transportState.roomCode!);
}

async function _sendProfile(peerId?: string): Promise<void> {
  const profile = await getOwnProfile();
  const name = profile?.nickname?.trim() || "Anonymous";
  const did = identityStore.did ?? null;
  let avatarUrl: string | null = profile?.pfpURL || null;
  if (!avatarUrl && profile?.pfpData) {
    const bytes = new Uint8Array(profile.pfpData);
    const binary = Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join("");
    avatarUrl = `data:image/jpeg;base64,${btoa(binary)}`;
  }

  if (peerId) {
    _transport.send(
      peerId,
      encode({ type: MessageType.Profile, name, did, avatarUrl })
    );
    return;
  }
  _transport.broadcast(
    encode({ type: MessageType.Profile, name, did, avatarUrl }),
    transportState.roomCode!
  );
}

async function _broadcastProfile(): Promise<void> {
  await _sendProfile().catch(() => {});
}

async function _sendDigest(peerId: string): Promise<void> {
  if (!transportState.roomCode) return;
  const watermarks = await getWatermarksForRoom(transportState.roomCode);
  await _transport.send(
    peerId,
    encode({ type: MessageType.SyncDigest, watermarks })
  );
}

// ── History ───────────────────────────────────────────────────────────────────

export async function _loadHistory(roomCode: string): Promise<void> {
  const [msgs, profiles] = await Promise.all([
    getMessages(roomCode),
    getAllPeerProfiles(),
  ]);
  transportState.messages = msgs;
  // DM rooms use wall-clock ms as their lamport — absorbing those here would
  // catapult the shared room clock to ~1.7e12 and skew every room after.
  if (msgs.length > 0 && !roomCode.startsWith("dm-")) {
    _lamport = Math.max(_lamport, ...msgs.map((m) => m.lamport));
  }
  if (profiles.length > 0) {
    const names = new Map(transportState.peerNames);
    const avatars = new Map(transportState.peerAvatars);
    for (const p of profiles) {
      names.set(p.did, p.nickname);
      if (p.pfpURL) avatars.set(p.did, p.pfpURL);
    }
    transportState.peerNames = names;
    transportState.peerAvatars = avatars;
  }

  for (const msg of msgs) {
    if (msg.type !== MessageType.File || !msg.meta?.files?.length) continue;
    for (const file of msg.meta.files) {
      if (transportState.fileTransfers.has(file.infoHash)) continue;
      withFileTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: 0,
      });
    }
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function _handleDigest(
  peerId: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const mine = await getWatermarksForRoom(transportState.roomCode);

  const theyAreMissing = Object.keys(mine).filter(
    (sid) => (theirWatermarks[sid] ?? -1) < mine[sid]
  );

  if (theyAreMissing.length > 0) {
    await _pushMissingTo(peerId, theirWatermarks);
  }
}

async function _pushMissingTo(
  peerId: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!transportState.roomCode) return;
  const all = await getAllMessages(transportState.roomCode);
  const missing = all.filter(
    (m) => m.lamport > (theirWatermarks[m.senderId] ?? -1)
  );

  if (!missing.length) return;

  const batches: WireChatMessage[][] = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    _transport.send(
      peerId,
      encode({
        type: MessageType.SyncBatch,
        messages: batches[i],
        batchIndex: i,
        totalBatches: batches.length,
      })
    );
  }

  _transport.send(peerId, encode({ type: MessageType.SyncComplete }));
}

async function _handleSyncBatch(messages: WireChatMessage[]): Promise<void> {
  if (!messages.length || !transportState.roomCode) return;

  const roomCode = transportState.roomCode;
  const verdicts = await Promise.all(messages.map(_verifyIncoming));
  const verified = messages.filter((_, i) => verdicts[i]);
  if (verified.length < messages.length) {
    console.warn(
      `[sync] dropped ${messages.length - verified.length} message(s) with invalid signatures`
    );
  }
  if (!verified.length) return;
  const fullMessages = verified.map((w) => wireToMessage(w, roomCode));

  await bulkPutMessages(fullMessages);

  for (const m of fullMessages) {
    lamportReceive(m.lamport);
    await setWatermark(m.roomCode, m.senderId, m.lamport);
  }

  refreshUnreadCount(roomCode).catch(() => {});

  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newMsgs = fullMessages.filter((m) => !existingIds.has(m.id));
  if (newMsgs.length > 0) {
    transportState.messages = [...transportState.messages, ...newMsgs].sort(
      (a, b) =>
        a.lamport !== b.lamport
          ? a.lamport - b.lamport
          : a.senderId.localeCompare(b.senderId)
    );
  }
}

function _handleSyncComplete(peerId: string): void {
  transportState.messages = [...transportState.messages].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );
  for (const pid of _transport.peers()) {
    if (pid !== peerId) _sendDigest(pid).catch(() => {});
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

function _handleProfile(peerId: string, msg: WireProfile): void {
  const did = msg.did ?? peerId;
  const isNewMapping = _peerIdToDid.get(peerId) !== did;
  _peerIdToDid.set(peerId, did);

  // Queued DMs are keyed by DID, and the "connect" event fires before we
  // know the peer's DID — so the real flush happens here, once the profile
  // (and with it the DID) has arrived.
  if (isNewMapping) flushQueuedDmForPeer(peerId).catch(() => {});

  const avatarUrl = normalizeAvatarUrl(msg.avatarUrl);

  const names = new Map(transportState.peerNames);
  names.set(did, msg.name);
  transportState.peerNames = names;

  const avatars = new Map(transportState.peerAvatars);
  if (avatarUrl) avatars.set(did, avatarUrl);
  else avatars.delete(did);
  transportState.peerAvatars = avatars;

  getPeerProfile(did)
    .then((existing) =>
      putPeerProfile({
        did,
        isMe: false,
        nickname: msg.name,
        pfpURL: avatarUrl,
        updatedAt: Date.now(),
        ...(existing?.pfpData ? { pfpData: existing.pfpData } : {}),
      }).catch(() => {})
    )
    .catch(() => {});
}

function _handleCallPresence(peerId: string, inCall: boolean, roomCode?: string): void {
  const next = new Set(transportState.callPeerIds);
  const roomNext = new Map(transportState.callPeerRooms);

  if (inCall && roomCode) {
    next.add(peerId);
    roomNext.set(peerId, roomCode);
  } else {
    next.delete(peerId);
    roomNext.delete(peerId);

    const parts = new Map(transportState.participants);
    parts.delete(peerId);
    transportState.participants = parts;

    const sfuNext = new Set(transportState.sfuPeerIds);
    sfuNext.delete(peerId);
    transportState.sfuPeerIds = sfuNext;

    const txNext = new Map(transportState.pendingTransmissions);
    txNext.delete(peerId);
    transportState.pendingTransmissions = txNext;

    if (transportState.watchingTransmissionPeerId === peerId) {
      transportState.watchingTransmissionPeerId = null;
      transportState.watchingTransmissionProducerId = null;
    }

    const callStateNext = new Map(transportState.callPeerStates);
    callStateNext.delete(peerId);
    transportState.callPeerStates = callStateNext;
  }

  transportState.callPeerIds = next;
  transportState.callPeerRooms = roomNext;
}

function _handleCallState(peerId: string, msg: WireCallState): void {
  const next = new Map(transportState.callPeerStates);
  next.set(peerId, {
    muted: !!msg.muted,
    deafened: !!msg.deafened,
  });
  transportState.callPeerStates = next;
}

function _handleRoomName(name: string): void {
  const trimmed = name.trim().slice(0, 64);
  if (trimmed.length > 0) transportState.roomName = trimmed;
}

function _handleJoinRoom(peerId: string): void {
  if (!transportState.roomCode) return;
  if (!peerId) return;
  const uniqueUsers = [...new Set(transportState.roomUsers)];
  if (!uniqueUsers.includes(peerId)) {
    uniqueUsers.push(peerId);
    transportState.roomUsers = uniqueUsers;
    addRoomParticipant(transportState.roomCode, peerId).catch(() => {});
  }
}

function _handleLeaveRoom(peerId: string): void {
  // Explicit leave - remove user from room list AND from peerId->DID mapping
  if (!transportState.roomCode) return;
  const currentUsers = new Set(transportState.roomUsers);
  if (currentUsers.has(peerId)) {
    currentUsers.delete(peerId);
    transportState.roomUsers = [...currentUsers];
    removeRoomParticipant(transportState.roomCode, peerId).catch(() => {});
  }
  // Clean up the peerId->DID mapping when user explicitly leaves
  _peerIdToDid.delete(peerId);
}

function _handleRoomUsersSync(participants: string[]): void {
  if (!transportState.roomCode) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const merged = new Set([...transportState.roomUsers, ...participants]);
  if (selfDid) merged.add(selfDid);
  transportState.roomUsers = [...merged];
}

function _broadcastJoinRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.JoinRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

function _broadcastLeaveRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.LeaveRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

/**
 * Authenticate an incoming chat message.
 * A signed message must verify (and senderDid must match the claimed
 * did:key senderId) or it is dropped. Unsigned messages are accepted:
 * history predating signing and DM messages mirrored by the receiver are
 * stored without a sig, and rejecting them silently destroys sync.
 * ponytail: unsigned did:key claims are still spoofable — tighten to
 * mandatory signatures once legacy history has aged out.
 */
async function _verifyIncoming(wire: WireChatMessage): Promise<boolean> {
  if (!wire.sig) return true;
  if (wire.senderId.startsWith("did:key:") && wire.senderDid !== wire.senderId)
    return false;
  if (!wire.senderDid) return false;
  return verifySignature(wire.senderDid, wire.sig, canonicalFor(wire));
}

function _handleChatMessage(
  wire: WireChatMessage,
  roomCodeOverride?: string,
  receivedFromPeerId?: string
): void {
  const roomCode = roomCodeOverride ?? transportState.roomCode;
  if (!roomCode) return;

  // DM rooms now start with "dm-" (hash-based)
  // We don't need to ensure room here - it should already exist from sender context

  lamportReceive(wire.lamport);

  const msg = wireToMessage(wire, roomCode);

  putMessage(msg).catch(() => {});
  setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
  refreshUnreadCount(msg.roomCode).catch(() => {});

  const isNewMessage = !transportState.messages.some((m) => m.id === msg.id);

  // DM rooms now start with "dm-" (hash-based format)
  if (isNewMessage && msg.roomCode.startsWith("dm-")) {
    transportState.dmVersion += 1;
  }

  if (
    isNewMessage &&
    transportState.chatMode === "room" &&
    transportState.roomCode === msg.roomCode
  ) {
    transportState.messages = [...transportState.messages, msg].sort((a, b) =>
      a.lamport !== b.lamport
        ? a.lamport - b.lamport
        : a.senderId.localeCompare(b.senderId)
    );
  }

  if (msg.type !== MessageType.File || !msg.meta?.files?.length) return;

  const seederPeerId =
    receivedFromPeerId ?? maybePeerIdFromSenderId(msg.senderId) ?? null;

  if (isNewMessage) {
    getAttachmentsByMessage(msg.id)
      .then((existing) => {
        if (existing.length > 0) return;
        const now = Date.now();
        return Promise.all(
          msg.meta!.files.map((file) =>
            putAttachment({
              id: crypto.randomUUID(),
              roomCode: msg.roomCode,
              messageId: msg.id,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
              infoHash: file.infoHash,
              status: "pending",
              createdAt: now,
            })
          )
        );
      })
      .catch(() => {});
  }

  for (const file of msg.meta.files) {
    if (seederPeerId) {
      _fileTransport.registerSeeder(file, seederPeerId);
    }
    if (shouldAutoDownload(file.mimeType)) {
      _fileTransport.ensureDownload(file);
    } else {
      withFileTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: 1,
      });
    }
  }
}

// ── Transport events ──────────────────────────────────────────────────────────

_transport.on("status", (status) => {
  switch (status.type) {
    case "relay-connected":
      transportState.relayConnected = true;
      break;
    case "relay-disconnected":
    case "relay-dial-failed":
    case "relay-reconnecting":
    case "relay-reconnect-failed":
      transportState.relayConnected = false;
      break;
  }
});

_transport.on("connect", (peerId) => {
  transportState.peers = _transport.peers();
  flushQueuedDmForPeer(peerId).catch(() => {});
  _fileTransport.onPeerConnect(peerId);
  _sendProfile(peerId);
  _sendRoomName(peerId);
  if (transportState.inCall) _sendCallPresence(peerId);
  if (transportState.inCall) _sendCallState(peerId);
  _sendDigest(peerId);
  const selfDid = identityStore.did ?? _transport.selfId();
  const participants = [...new Set([...transportState.roomUsers, selfDid])];
  _transport.send(
    peerId,
    encode({ type: MessageType.RoomUsersSync, participants })
  );
});

_transport.on("disconnect", (peerId) => {
  transportState.peers = _transport.peers();
  _fileTransport.onPeerDisconnect(peerId);

  // Note: We intentionally do NOT delete the peerId->DID mapping here.
  // The mapping is kept so we can still identify which DID a peerId
  // belonged to for offline user tracking. The mapping is only removed
  // when we receive an explicit LeaveRoom message.

  const parts = new Map(transportState.participants);
  parts.delete(peerId);
  transportState.participants = parts;

  const calls = new Set(transportState.callPeerIds);
  calls.delete(peerId);
  transportState.callPeerIds = calls;

  const callStates = new Map(transportState.callPeerStates);
  callStates.delete(peerId);
  transportState.callPeerStates = callStates;

  const sfuNext = new Set(transportState.sfuPeerIds);
  sfuNext.delete(peerId);
  transportState.sfuPeerIds = sfuNext;

  const txNext = new Map(transportState.pendingTransmissions);
  txNext.delete(peerId);
  transportState.pendingTransmissions = txNext;

  if (transportState.watchingTransmissionPeerId === peerId) {
    transportState.watchingTransmissionPeerId = null;
    transportState.watchingTransmissionProducerId = null;
  }
});

_transport.on("message", (peerId, data, room) => {
  if (room === null) {
    const envelope = parseDmEnvelope(data);
    if (envelope) {
      if (envelope.type === "ack") {
        applyMessageStatus(envelope.messageId, "delivered");
        return;
      }

      if (envelope.type === "read") {
        for (const id of envelope.messageIds) {
          applyMessageStatus(id, "read");
        }
        return;
      }

      // Handle incoming DM chat message
      const senderDid = _peerIdToDid.get(peerId) ?? peerId;
      (async () => {
        const roomCode = await ensureDmRoomForPeer(peerId);
        _transport.joinRoom(roomCode);

        const msg: Message = {
          id: envelope.payload.id,
          roomCode,
          senderId: senderDid,
          senderName: resolveDmDisplayName(peerId),
          timestamp: envelope.payload.ts,
          lamport: envelope.payload.ts,
          type: MessageType.Text,
          content: envelope.payload.text,
          attachments: [],
          status: "delivered",
        };

        if (!transportState.messages.some((m) => m.id === msg.id)) {
          await putMessage(msg);
          await refreshDmRooms();
          transportState.dmVersion += 1;
          const activeDid = peerIdToDid(transportState.activeDmPeerId ?? "");
          const isViewingThisDm =
            transportState.chatMode === "dm" &&
            (activeDid === senderDid || activeDid === peerId);
          if (isViewingThisDm) {
            transportState.messages = [...transportState.messages, msg].sort(
              (a, b) => a.timestamp - b.timestamp
            );
            await markRoomSeen(roomCode, msg.lamport);
            const roomIndex = roomsStore.dmRooms.findIndex(
              (r) => r.roomCode === roomCode
            );
            if (roomIndex !== -1) {
              roomsStore.dmRooms[roomIndex] = {
                ...roomsStore.dmRooms[roomIndex],
                lastSeenLamport: msg.lamport,
              };
            }
            await refreshDmRooms();
            transportState.dmVersion += 1;
            // Conversation is on screen — this message is read, not just delivered
            _transport
              .send(peerId, encodeDmReadEnvelope([envelope.payload.id]))
              .catch(() => {});
          }
        }

        _transport
          .send(peerId, encodeDmAckEnvelope(envelope.payload.id))
          .catch(() => {});
      })().catch(console.error);
      return;
    }
  }

  try {
    const decoded = decode(data);
    if (isFileSignalWireMessage(decoded)) {
      if (decoded.payload.kind === "file-seeder") {
        _fileTransport.registerSeeder(decoded.payload.file, peerId);
        if (shouldAutoDownload(decoded.payload.file.mimeType)) {
          _fileTransport.ensureDownload(decoded.payload.file);
        }
      } else {
        _fileTransport.handleSignal(peerId, decoded.payload);
      }
      return;
    }

    // Update last seen for this peer
    const did = _peerIdToDid.get(peerId);
    if (did && transportState.roomCode) {
      updateParticipantLastSeen(transportState.roomCode, did).catch(() => {});
    }

    const msg = decoded as AnyWireMessage;

    switch (msg.type) {
      case MessageType.Profile:
        _handleProfile(peerId, msg);
        break;
      case MessageType.CallPresence:
        _handleCallPresence(peerId, msg.inCall, msg.roomCode);
        break;
      case MessageType.CallState:
        _handleCallState(peerId, msg);
        break;
      case MessageType.RoomName:
        _handleRoomName(msg.name);
        break;
      case MessageType.JoinRoom:
        _handleJoinRoom(msg.peerId);
        break;
      case MessageType.LeaveRoom:
        _handleLeaveRoom(msg.peerId);
        break;
      case MessageType.RoomUsersSync:
        _handleRoomUsersSync(msg.participants);
        break;
      case MessageType.SyncDigest:
        _handleDigest(peerId, msg.watermarks).catch(() => {});
        break;
      case MessageType.SyncBatch:
        _handleSyncBatch(msg.messages).catch(() => {});
        break;
      case MessageType.SyncComplete:
        _handleSyncComplete(peerId);
        break;
      case MessageType.Text:
      case MessageType.Reply:
      case MessageType.Reaction:
      case MessageType.File:
        _verifyIncoming(msg)
          .then((ok) => {
            if (ok) _handleChatMessage(msg, room ?? undefined, peerId);
            else
              console.warn(
                "[app] dropped message with invalid signature from",
                msg.senderId
              );
          })
          .catch(() => {});
        break;
    }
  } catch (e) {
    console.warn("[app] message decode failed", e, data);
  }
});

// ── Public API ────────────────────────────────────────────────────────────────

const CONNECT_RETRY_BASE_MS = 3_000;
const CONNECT_RETRY_MAX_MS = 30_000;
let _connectRetryDelay = CONNECT_RETRY_BASE_MS;
let _connectRetryTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleConnectRetry(): void {
  if (_connectRetryTimer) return;
  _connectRetryTimer = setTimeout(() => {
    _connectRetryTimer = null;
    // Stop retrying if the identity got locked in the meantime
    try {
      requireSession();
    } catch {
      return;
    }
    connect().catch(() => {});
  }, _connectRetryDelay);
  _connectRetryDelay = Math.min(_connectRetryDelay * 2, CONNECT_RETRY_MAX_MS);
}

export async function connect() {
  if (transportState.relayConnected) return;
  if (_connectPromise) {
    await _connectPromise;
    return;
  }

  _connectPromise = (async () => {
    try {
      await _transport.connect(requireSession().privateKey);
      transportState.relayConnected = true;
      transportState.error = null;
      _connectRetryDelay = CONNECT_RETRY_BASE_MS;
      joinPhonebookDmRooms().catch(() => {});
    } catch (err) {
      transportState.error = err instanceof Error ? err.message : String(err);
      transportState.relayConnected = false;
      _scheduleConnectRetry();
    } finally {
      _connectPromise = null;
    }
  })();

  await _connectPromise;
}

export async function joinRoom(roomCode: string): Promise<void> {
  if (!transportState.relayConnected) {
    await connect();
  }

  if (!transportState.relayConnected) {
    transportState.error = "Transport not connected to relay";
    transportState.connecting = false;
    return;
  }

  transportState.error = null;
  transportState.connecting = true;
  try {
    await _loadHistory(roomCode);
    await _hydrateFileTransfersFromStorage(roomCode);
    _transport.joinRoom(roomCode);
    transportState.connected = true;
    transportState.chatMode = "room";
    transportState.activeDmPeerId = null;
    transportState.connecting = false;
    transportState.roomCode = roomCode;
    transportState.roomName = "";
    transportState.peers = _transport.peers();
    const selfDid = identityStore.did ?? _transport.selfId();
    const savedParticipants = await getRoomParticipants(roomCode);
    // Clean up inactive participants (not seen in 7 days)
    const removedInactive = await cleanupInactiveParticipants(roomCode);
    if (removedInactive.length > 0) {
      console.log("[room] removed inactive participants:", removedInactive);
    }
    const participants = new Set(
      savedParticipants.filter((p) => !removedInactive.includes(p))
    );
    participants.add(selfDid);
    transportState.roomUsers = [...participants];
    await addRoomParticipant(roomCode, selfDid);
    // Best-effort: one corrupt stored attachment must not block joining
    await _resumeAttachmentSeeding(roomCode).catch((err) =>
      console.warn("[room] attachment re-seed failed:", err)
    );
    await _broadcastProfile();
    _broadcastJoinRoom();
  } catch (err) {
    transportState.error = err instanceof Error ? err.message : String(err);
    transportState.connecting = false;
    throw err;
  }
}

export function getRoomUsers(): string[] {
  return transportState.roomUsers;
}

export function leaveRoom(): void {
  _broadcastLeaveRoomAndDisconnect();
}

function _broadcastLeaveRoomAndDisconnect(): void {
  const roomCode = transportState.roomCode;
  const selfDid = identityStore.did ?? _transport.selfId();
  if (roomCode && selfDid) {
    _broadcastLeaveRoom();
  }
  _disconnectWithoutBroadcasting();
}

function _disconnectWithoutBroadcasting(): void {
  for (const transfer of transportState.fileTransfers.values()) {
    if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
  }
  leaveCall();
  _transport.disconnect();
  _peerIdToDid.clear();
  transportState.connected = false;
  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.peers = [];
  transportState.messages = [];
  transportState.participants = new Map();
  transportState.peerNames = new Map();
  transportState.peerAvatars = new Map();
  transportState.error = null;
  transportState.callPeerIds = new Set();
  transportState.sfuPeerIds = new Set();
  transportState.pendingTransmissions = new Map();
  transportState.watchingTransmissionPeerId = null;
  transportState.watchingTransmissionProducerId = null;
  transportState.fileTransfers = new Map();
  transportState.callPeerStates = new Map();
  transportState.chatMode = "room";
  transportState.activeDmPeerId = null;
}

export async function sendMessage(
  text: string,
  options: SendMessageOptions = {}
): Promise<void> {
  if (transportState.chatMode === "dm") {
    await sendDirectMessage(text);
    return;
  }
  if (!transportState.roomCode) return;

  const profile = await getOwnProfile();
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  const lamport = lamportSend();

  let msg: Message = {
    id: crypto.randomUUID(),
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: Date.now(),
    lamport,
    type: options.type ?? MessageType.Text,
    content: text,
    meta: options.meta,
    attachments: options.attachments ?? [],
    replyTo: options.replyTo,
    reactionTo: options.reactionTo,
    reactionEmoji: options.reactionEmoji,
    reactionOp: options.reactionOp,
  };

  // Sign the message before sending
  msg = signMessage(msg);

  _transport.broadcast(encode(messageToWire(msg)), transportState.roomCode);

  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = [...transportState.messages, msg].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
}

export async function sendReply(text: string, target: Message): Promise<void> {
  const snapshot =
    target.content.length > 160
      ? `${target.content.slice(0, 157)}...`
      : target.content;
  await sendMessage(text, {
    type: MessageType.Reply,
    replyTo: {
      id: target.id,
      senderName: target.senderName,
      content: snapshot,
    },
  });
}

export async function sendFiles(
  files: File[],
  text = "",
  options: Pick<SendMessageOptions, "replyTo"> = {}
): Promise<void> {
  if (!transportState.roomCode || !files.length) return;

  const seeded: FileDescriptor[] = [];
  const sourceByInfoHash = new Map<string, File>();

  for (const file of files) {
    const fingerprint = await fileFingerprint(file);
    const existing = _seededByFingerprint.get(fingerprint);
    if (existing) {
      seeded.push(existing);
      sourceByInfoHash.set(existing.infoHash, file);
      continue;
    }

    const [newSeed] = await _fileTransport.seedFiles([file]);
    _seededByFingerprint.set(fingerprint, newSeed);
    seeded.push(newSeed);
    sourceByInfoHash.set(newSeed.infoHash, file);
  }

  const messageId = crypto.randomUUID();
  const attachmentIds: string[] = [];
  const createdAt = Date.now();

  for (let i = 0; i < seeded.length; i += 1) {
    const seededFile = seeded[i];
    const source = sourceByInfoHash.get(seededFile.infoHash);
    if (!source) continue;
    const canPersistData = source.size <= MAX_PERSISTED_ATTACHMENT_BYTES;
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      roomCode: transportState.roomCode,
      messageId,
      filename: seededFile.filename,
      mimeType: seededFile.mimeType,
      size: seededFile.size,
      infoHash: seededFile.infoHash,
      status: "seeding",
      createdAt,
      data: canPersistData ? await source.arrayBuffer() : undefined,
    };
    attachmentIds.push(attachment.id);
    await putAttachment(attachment);

    withFileTransfer({
      ...seededFile,
      status: "seeding",
      progress: 1,
      done: true,
      seeding: true,
      peers: 0,
      seeders: 1,
      blobURL: URL.createObjectURL(source),
    });
  }

  const profile = await getOwnProfile();
  const senderName = profile?.nickname?.trim() || "Anonymous";
  const myId = identityStore.did ?? _transport.selfId();
  const lamport = lamportSend();

  let msg: Message = {
    id: messageId,
    roomCode: transportState.roomCode,
    senderId: myId,
    senderName,
    timestamp: createdAt,
    lamport,
    type: MessageType.File,
    content: text.trim(),
    meta: { files: seeded },
    attachments: attachmentIds,
    replyTo: options.replyTo,
  };

  msg = signMessage(msg);

  _transport.broadcast(encode(messageToWire(msg)), transportState.roomCode);
  await putMessage(msg);
  await setWatermark(msg.roomCode, msg.senderId, msg.lamport);

  transportState.messages = [...transportState.messages, msg].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );

  markRoomSeen(msg.roomCode, msg.lamport).catch(() => {});
}

export function requestFileDownload(
  file: FileEntry,
  senderId?: string | null
): void {
  const peerId = senderId ? maybePeerIdFromSenderId(senderId) : null;
  if (peerId) {
    _fileTransport.registerSeeder(file, peerId);
  }
  _fileTransport.ensureDownload(file);
}

export async function toggleReaction(
  messageId: string,
  emoji: string
): Promise<void> {
  const existing = transportState.messages
    .filter(
      (m) =>
        m.type === MessageType.Reaction &&
        m.reactionTo === messageId &&
        m.reactionEmoji === emoji
    )
    .sort((a, b) => b.lamport - a.lamport)
    .find((m) => m.senderId === (identityStore.did ?? _transport.selfId()));

  await sendMessage("", {
    type: MessageType.Reaction,
    reactionTo: messageId,
    reactionEmoji: emoji,
    reactionOp: existing?.reactionOp === "add" ? "remove" : "add",
  });
}

export async function loadMoreMessages(
  beforeLamport: number
): Promise<boolean> {
  if (!transportState.roomCode) return false;
  const older = await getMessages(transportState.roomCode, beforeLamport);
  if (!older.length) return false;
  const existingIds = new Set(transportState.messages.map((m) => m.id));
  const newOnes = older.filter((m) => !existingIds.has(m.id));
  transportState.messages = [...newOnes, ...transportState.messages].sort(
    (a, b) =>
      a.lamport !== b.lamport
        ? a.lamport - b.lamport
        : a.senderId.localeCompare(b.senderId)
  );
  return newOnes.length === 50;
}

export async function markSeen(): Promise<void> {
  if (!transportState.roomCode || !transportState.messages.length) return;
  const roomCode = transportState.roomCode;
  const maxLamport = Math.max(...transportState.messages.map((m) => m.lamport));
  await markRoomSeen(roomCode, maxLamport);
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx !== -1) {
    roomsStore.rooms[idx] = {
      ...roomsStore.rooms[idx],
      lastSeenLamport: maxLamport,
    };
  }
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, 0);
  roomsStore.unreadCounts = next;
}

export function broadcastProfile(): void {
  _broadcastProfile().catch(() => {});
}

export function setRoomName(name: string): void {
  transportState.roomName = name.trim().slice(0, 64);
  _sendRoomName();
}

export function selfId(): string {
  return identityStore.did ?? _transport.selfId();
}

export function peerId(): string {
  return _transport.selfId();
}

export function peerIdToDid(peerId: string): string {
  return _peerIdToDid.get(peerId) ?? peerId;
}

export function didToPeerId(did: string): string | null {
  for (const [peerId, mappedDid] of _peerIdToDid) {
    if (mappedDid === did) return peerId;
  }
  return null;
}

export function isRelayed(peerId: string): boolean {
  return _transport.isRelayed(peerId);
}
