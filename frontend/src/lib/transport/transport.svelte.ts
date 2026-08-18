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
  getMessage,
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
  type WireRoomName,
  type WireRoomUsersSync,
  type WireCallState,
  type FileEntry,
  type FileMeta,
  type Attachment,
} from "../types/message";
import {
  refreshUnreadCount,
  refreshDmRooms,
  renameRoom,
  noteRoomActivity,
  roomsStore,
} from "../rooms.svelte";
import { WebTorrentFileTransport } from "./file/webtorrent";
import type { FileDescriptor, FileTransferSnapshot } from "./types";
import { LibP2PTransport } from "./libp2p/transport";
import { refreshTurnCredentials } from "./ice-server-list";
import { LibP2PVoice } from "./libp2p/voice";
import { DtlnProcessor } from "../audio/dtln-processor";
import { requireSession } from "../identity/identity";
import { deviceKeySeed } from "./device-key";
import { looksLikeDid, looksLikePeerId } from "../identity/identity-utils";
import {
  canonicalFor,
  signMessage,
  signPeerBinding,
  verifyPeerBinding,
  verifySignature,
} from "../messaging";
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
import { notifyMessage } from "../notify.svelte";
import { playPeerJoinSound, playPeerLeaveSound } from "../sounds";
import { peerCallChime } from "./call-chime";

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
  /** Bumped on every peer->DID mapping change; see peerIdToDid(). */
  peerDidVersion: number;
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
  peerDidVersion: 0,
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

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle: presence and profile bugs are only reproducible with two
  // real peers, and there is no other way to see this state from a test.
  (window as unknown as Record<string, unknown>).__awful = {
    state: transportState,
    peerIdToDid: _peerIdToDid,
    selfId: () => _transport.selfId(),
    node: () => _transport.p2pNode,
  };
}

/**
 * DM frames that arrived before the sender's DID was known, replayed once the
 * binding lands. Bounded: an unbound peer must not be able to make us buffer
 * without limit.
 */
type PendingDm = { payload: { id: string; text: string; ts: number } };
const _pendingDmByPeer = new Map<string, PendingDm[]>();
const MAX_PENDING_DM_PER_PEER = 32;

function _replayPendingDm(peerId: string, senderDid: string): void {
  const pending = _pendingDmByPeer.get(peerId);
  if (!pending?.length) return;
  _pendingDmByPeer.delete(peerId);
  for (const envelope of pending) _handleDmChat(peerId, senderDid, envelope);
}

/** Mutate the peer->DID map through here so reactive readers are notified. */
function _setPeerDid(peerId: string, did: string): void {
  if (_peerIdToDid.get(peerId) === did) return;
  _peerIdToDid.set(peerId, did);
  transportState.peerDidVersion += 1;
}
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
  const roomCode = transportState.roomCode;
  const name = transportState.roomName.trim().slice(0, 64);
  if (!name || !roomCode) return;
  // roomCode travels with it: a direct send has no topic to infer it from, so
  // the receiver used to apply the name to whatever room they had open.
  const payload = encode({ type: MessageType.RoomName, name, roomCode });
  if (peerId) _transport.send(peerId, payload);
  else _transport.broadcast(payload, roomCode);
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

  // Prove this DID owns our peerId; the receiver cannot derive it any more.
  let binding: { did: string; bindingSig: string } | null = null;
  try {
    binding = signPeerBinding(_transport.selfId());
  } catch {
    binding = null; // identity locked: the peer just will not bind us yet
  }

  const payload = encode({
    type: MessageType.Profile,
    name,
    did,
    avatarUrl,
    peerId: _transport.selfId(),
    bindingSig: binding?.bindingSig,
  });

  if (peerId) {
    _transport.send(peerId, payload);
    return;
  }

  // Reach everyone who could care: every room we are in (not just the one on
  // screen) and every connected peer directly. A single broadcast to the
  // active room missed peers in other shared rooms, and was silently dropped
  // when the gossipsub mesh had not formed yet - which is why a changed
  // nickname or avatar often never showed up for anyone.
  for (const room of _transport.rooms()) {
    _transport.broadcast(payload, room);
  }
  for (const pid of _transport.peers()) {
    _transport.send(pid, payload).catch(() => {});
  }
}

async function _broadcastProfile(): Promise<void> {
  await _sendProfile().catch(() => {});
}

/**
 * Digests are cheap (one number per sender) and idempotent, so the recovery
 * story is "exchange one whenever there is reason to think we drifted" rather
 * than polling. Debounced per peer so a burst of reasons costs one digest.
 */
const SYNC_DEBOUNCE_MS = 10_000;
const _lastDigestAt = new Map<string, number>();
/** "room|senderId" -> highest lamport we have seen, for the gap hint above. */
const _lastSeenLamport = new Map<string, number>();

function _syncPeer(peerId: string, force = false): void {
  const now = Date.now();
  if (!force && now - (_lastDigestAt.get(peerId) ?? 0) < SYNC_DEBOUNCE_MS) {
    return;
  }
  _lastDigestAt.set(peerId, now);
  _sendDigest(peerId).catch(() => {});
}

/** Reconcile with everyone we are connected to. */
function _syncAllPeers(force = false): void {
  for (const pid of _transport.peers()) _syncPeer(pid, force);
}

/** Away longer than this and the connections are suspect, not just history. */
const AWAY_FULL_RESYNC_MS = 60_000;
let _hiddenSince = 0;

/**
 * Everything a peer needs to know about us, plus a request for everything we
 * need from them. Cheap enough to fire on returning to the app.
 */
function _resyncEverything(): void {
  _transport.reconcileNow();
  _broadcastProfile().catch(() => {});
  if (transportState.roomCode) _broadcastJoinRoom();
  if (transportState.inCall) {
    _sendCallPresence();
    _sendCallState();
  }
  _syncAllPeers(true);
}

if (typeof document !== "undefined") {
  // Coming back from the background is the big one: a phone that slept has
  // missed whatever happened meanwhile, and nothing inside the app will ever
  // tell it so.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      _hiddenSince = Date.now();
      return;
    }
    const away = _hiddenSince ? Date.now() - _hiddenSince : 0;
    _hiddenSince = 0;
    // A glance away only needs history reconciled. A long absence means the
    // connections themselves may be stale, so re-announce and re-dial too.
    if (away > AWAY_FULL_RESYNC_MS) _resyncEverything();
    else _syncAllPeers();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => _resyncEverything());
}

async function _sendDigest(peerId: string): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  const watermarks = await getWatermarksForRoom(roomCode);
  await _transport.send(
    peerId,
    encode({ type: MessageType.SyncDigest, roomCode, watermarks })
  );
}

// ── History ───────────────────────────────────────────────────────────────────

export async function _loadHistory(roomCode: string): Promise<void> {
  const [msgs, profiles] = await Promise.all([
    getMessages(roomCode),
    getAllPeerProfiles(),
  ]);
  transportState.messages = msgs;
  // DM rooms use wall-clock ms as their lamport - absorbing those here would
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
  roomCode: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  // Only reconcile a room we have actually joined - never a room the sender
  // merely named, and never fall back to whatever room the UI has open.
  if (!roomCode || !_transport.rooms().includes(roomCode)) return;
  const mine = await getWatermarksForRoom(roomCode);

  const theyAreMissing = Object.keys(mine).filter(
    (sid) => (theirWatermarks[sid] ?? -1) < mine[sid]
  );

  if (theyAreMissing.length > 0) {
    await _pushMissingTo(peerId, roomCode, theirWatermarks);
  }
}

async function _pushMissingTo(
  peerId: string,
  roomCode: string,
  theirWatermarks: Record<string, number>
): Promise<void> {
  if (!roomCode) return;
  const all = await getAllMessages(roomCode);
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
        roomCode,
        messages: batches[i],
        batchIndex: i,
        totalBatches: batches.length,
      })
    );
  }

  _transport.send(peerId, encode({ type: MessageType.SyncComplete, roomCode }));
}

async function _handleSyncBatch(
  roomCode: string,
  messages: WireChatMessage[]
): Promise<void> {
  // Bind incoming history to the room named in the (signed-message-bearing)
  // batch, and only if we actually joined it - a peer cannot inject history
  // into whatever room the receiver currently has open.
  if (!messages.length || !roomCode || !_transport.rooms().includes(roomCode))
    return;
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
  for (const m of fullMessages) noteRoomActivity(m.roomCode, m.timestamp);

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

async function _handleProfile(peerId: string, msg: WireProfile): Promise<void> {
  // Bind the DID to the peerId only on a signature over THIS connection's
  // peerId. The `did` field on its own is spoofable, and any peer could
  // otherwise claim someone else's identity and hijack their DM conversation
  // or poison their cached profile.
  const claimed = msg.did;
  const proven =
    claimed &&
    msg.peerId === peerId &&
    msg.bindingSig &&
    (await verifyPeerBinding(claimed, peerId, msg.bindingSig));
  if (!proven) return;
  const did = claimed as string;
  const isNewMapping = _peerIdToDid.get(peerId) !== did;
  _setPeerDid(peerId, did);

  // Queued DMs are keyed by DID, and the "connect" event fires before we
  // know the peer's DID - so the real flush happens here, once the profile
  // (and with it the DID) has arrived.
  if (isNewMapping) {
    flushQueuedDmForPeer(peerId).catch(() => {});
    _replayPendingDm(peerId, did);
    // Answer with everything about our current state.
    //
    // These are otherwise only sent when the "connect" event fires. After one
    // side reloads, the other often still has the connection open and never
    // sees a new connect, so it never re-sends - leaving the reloaded peer
    // with no DID for it (shown offline, no name) and no idea it is in a call,
    // while voice and gossipsub carry on over the connection that was never
    // lost. Replying here makes the exchange mutual whoever starts it, and it
    // settles after one extra round because the reply only fires on a NEW
    // mapping.
    _sendProfile(peerId);
    if (transportState.inCall) {
      _sendCallPresence(peerId);
      _sendCallState(peerId);
    }
    // They are new to us, so anything they said before we bound them is
    // missing: reconcile history with them too.
    _sendDigest(peerId).catch(() => {});
  }

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

/** Chime when somebody else joins or leaves the call we are sitting in. */
function _peerCallSound(
  room: string | undefined,
  nowInCall: boolean,
  wasInCall: boolean
): void {
  const chime = peerCallChime({
    imInCall: transportState.inCall,
    myCallRoom: transportState.callRoomCode,
    room,
    wasInCall,
    nowInCall,
  });
  if (chime === "join") playPeerJoinSound();
  else if (chime === "leave") playPeerLeaveSound();
}

function _handleCallPresence(
  peerId: string,
  inCall: boolean,
  roomCode?: string
): void {
  const next = new Set(transportState.callPeerIds);
  const roomNext = new Map(transportState.callPeerRooms);
  const wasInCall = next.has(peerId);
  const theirRoom = roomNext.get(peerId);

  if (inCall && roomCode) {
    next.add(peerId);
    roomNext.set(peerId, roomCode);
    _peerCallSound(roomCode, true, wasInCall);
  } else {
    next.delete(peerId);
    roomNext.delete(peerId);
    _peerCallSound(theirRoom, false, wasInCall);

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

function _handleRoomName(msg: WireRoomName, room: string | null): void {
  // The room this name is for, NOT the one on screen: we stay subscribed to
  // every room we have joined, so applying it to the current room renamed
  // whichever room you happened to be looking at.
  const target = msg.roomCode ?? room;
  if (!target) return;
  const trimmed = msg.name.trim().slice(0, 64);
  if (!trimmed) return;
  // A peer that joined from a bare invite link has no name yet and sends the
  // room code as a placeholder. Accepting it would overwrite the real name for
  // everyone in the room.
  if (trimmed === target) return;
  renameRoom(target, trimmed).catch(() => {});
  if (target === transportState.roomCode) transportState.roomName = trimmed;
}

/**
 * A peer may only announce ITSELF. `claimedDid` arrives in the message body,
 * which anybody in the room can write, so it is checked against the DID bound
 * to the authenticated connection it came in on. Without that check a peer
 * could evict anyone from everyone else's member list (see _handleLeaveRoom)
 * or stuff the list with identities that were never here.
 */
function _isSelfAnnouncement(fromPeerId: string, claimedDid: string): boolean {
  if (!claimedDid) return false;
  const senderDid = _peerIdToDid.get(fromPeerId);
  return !!senderDid && senderDid === claimedDid;
}

function _handleJoinRoom(
  _fromPeerId: string,
  claimedDid: string,
  room: string | null
): void {
  if (!room) return;
  if (!claimedDid) return;
  // Deliberately NOT restricted to self-announcements: this only ever adds,
  // RoomUsersSync already accepts additions from anyone, and a join often
  // arrives before the sender's profile has bound their DID - rejecting it
  // then would leave them missing from the list entirely.
  if (room !== transportState.roomCode) {
    // Another room we are subscribed to: record it, but do not touch the
    // member list on screen.
    addRoomParticipant(room, claimedDid).catch(() => {});
    return;
  }
  const uniqueUsers = [...new Set(transportState.roomUsers)];
  if (!uniqueUsers.includes(claimedDid)) {
    uniqueUsers.push(claimedDid);
    transportState.roomUsers = uniqueUsers;
    addRoomParticipant(room, claimedDid).catch(() => {});
  }
}

/**
 * Explicit leave: drop the user from the member list and from storage. This is
 * the only thing that removes somebody - going offline must not, or a peer that
 * closed their laptop would vanish instead of showing as offline.
 */
function _handleLeaveRoom(
  fromPeerId: string,
  claimedDid: string,
  room: string | null
): void {
  if (!room) return;
  if (!_isSelfAnnouncement(fromPeerId, claimedDid)) return;
  removeRoomParticipant(room, claimedDid).catch(() => {});
  if (room === transportState.roomCode) {
    const currentUsers = new Set(transportState.roomUsers);
    if (currentUsers.has(claimedDid)) {
      currentUsers.delete(claimedDid);
      transportState.roomUsers = [...currentUsers];
    }
  }
  // Keyed by the libp2p peerId, not the DID: deleting claimedDid here was a
  // no-op and left the mapping behind.
  _peerIdToDid.delete(fromPeerId);
  transportState.peerDidVersion += 1;
}

// A room's participant list is presence metadata, not a security boundary,
// but a peer must not be able to grow it without bound or stuff it with junk.
const MAX_ROOM_USERS = 512;

function _handleRoomUsersSync(
  msg: WireRoomUsersSync,
  room: string | null
): void {
  const roomCode = msg.roomCode ?? room;
  if (!roomCode) return;
  const participants = msg.participants;
  if (!Array.isArray(participants)) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  const valid = participants.filter(
    (p) => typeof p === "string" && (looksLikeDid(p) || looksLikePeerId(p))
  );
  if (roomCode !== transportState.roomCode) {
    // A list for a room we are subscribed to but not looking at. Persist it,
    // but leave the on-screen member list alone - merging it in was how one
    // room's members ended up listed in another.
    for (const did of valid.slice(0, MAX_ROOM_USERS)) {
      addRoomParticipant(roomCode, did).catch(() => {});
    }
    return;
  }
  const known = new Set(transportState.roomUsers);
  const merged = new Set([...known, ...valid]);
  if (selfDid) merged.add(selfDid);
  const next = [...merged].slice(0, MAX_ROOM_USERS);
  transportState.roomUsers = next;

  // Persist whoever is new to us. Only a JoinRoom announcement used to be
  // written down, and you only receive that if you were already in the room
  // when they joined - so everybody who was there before you lived in memory
  // alone and disappeared from the member list on your next reload. Existing
  // entries are left untouched so this does not keep resetting their
  // inactivity window.
  for (const did of next) {
    if (!known.has(did)) addRoomParticipant(roomCode, did).catch(() => {});
  }
}

function _broadcastJoinRoom(): void {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return;
  _transport.broadcast(
    encode({ type: MessageType.JoinRoom, peerId: selfDid }),
    transportState.roomCode
  );
}

function _broadcastLeaveRoom(): Promise<void> {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid || !transportState.roomCode) return Promise.resolve();
  return _transport.broadcast(
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
 * ponytail: unsigned did:key claims are still spoofable - tighten to
 * mandatory signatures once legacy history has aged out.
 */
async function _verifyIncoming(wire: WireChatMessage): Promise<boolean> {
  if (!wire.sig) return true;
  // A signature MUST use the v2 canonical form (which covers reaction/reply/
  // file fields). The weak v1 form left those unsigned, so accepting a v1 sig
  // would let a relay swap an infoHash/emoji on a signed message undetected.
  if (wire.sigV !== 2) return false;
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

  // A sender's lamport only ever moves forward, so a jump past what we have
  // from them means we probably missed something. It is a hint, not proof -
  // the clock also advances on receives - but a digest is small and answering
  // one costs nothing, so erring towards syncing is the cheap side.
  if (receivedFromPeerId) {
    const seen = _lastSeenLamport.get(`${roomCode}|${msg.senderId}`) ?? -1;
    if (seen >= 0 && msg.lamport > seen + 1) _syncPeer(receivedFromPeerId);
    if (msg.lamport > seen) {
      _lastSeenLamport.set(`${roomCode}|${msg.senderId}`, msg.lamport);
    }
  }

  putMessage(msg).catch(() => {});
  setWatermark(msg.roomCode, msg.senderId, msg.lamport).catch(() => {});
  refreshUnreadCount(msg.roomCode).catch(() => {});
  noteRoomActivity(msg.roomCode, msg.timestamp);

  const isNewMessage = !transportState.messages.some((m) => m.id === msg.id);

  // DM rooms now start with "dm-" (hash-based format)
  if (isNewMessage && msg.roomCode.startsWith("dm-")) {
    transportState.dmVersion += 1;
  }

  // Reactions are noise as notifications, and a message replayed by sync is
  // not news - only announce genuinely new chat arriving from someone else.
  if (
    isNewMessage &&
    msg.type !== MessageType.Reaction &&
    msg.senderId !== (identityStore.did ?? _transport.selfId())
  ) {
    notifyMessage({
      title: transportState.roomName || msg.roomCode,
      body: `${msg.senderName}: ${msg.content || "[file]"}`,
      tag: `room:${msg.roomCode}`,
    });
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
  // The DID cannot be derived from the peerId any more (devices carry their
  // own libp2p keys); it arrives with the signed binding in the Profile.
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
    encode({
      type: MessageType.RoomUsersSync,
      participants,
      roomCode: transportState.roomCode ?? undefined,
    })
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

  // A peer that drops out never sends a leave, so the chime belongs here too.
  const calls = new Set(transportState.callPeerIds);
  _peerCallSound(
    transportState.callPeerRooms.get(peerId),
    false,
    calls.has(peerId)
  );
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

/**
 * An incoming DM, once we know who sent it.
 *
 * Split out of the message handler so a frame that arrived before the sender's
 * DID was bound can be replayed through exactly the same path.
 */
function _handleDmChat(
  peerId: string,
  senderDid: string,
  envelope: { payload: { id: string; text: string; ts: number } }
): void {
  void (async () => {
    const roomCode = await ensureDmRoomForPeer(peerId);
    if (!roomCode) return;
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

    // Against storage, not the on-screen list: that list holds whichever
    // conversation is open, so a redelivered message was only recognised
    // as a duplicate when you happened to be looking at that DM.
    if (!(await getMessage(msg.id))) {
      await putMessage(msg);
      await refreshDmRooms();
      transportState.dmVersion += 1;
      notifyMessage({
        title: msg.senderName,
        body: msg.content,
        tag: `dm:${roomCode}`,
      });
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
        // Conversation is on screen - this message is read, not just delivered
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

      // Handle incoming DM chat message.
      // Until the sender's profile has bound their peerId to a DID we cannot
      // tell which conversation this belongs to: the room code is a hash of
      // the two DIDs. Hold it and replay once the binding lands, rather than
      // filing it in a peerId-derived thread the sender never reads.
      const senderDid = _peerIdToDid.get(peerId);
      if (!senderDid) {
        const pending = _pendingDmByPeer.get(peerId) ?? [];
        if (pending.length < MAX_PENDING_DM_PER_PEER) {
          pending.push(envelope);
          _pendingDmByPeer.set(peerId, pending);
        }
        return;
      }
      _handleDmChat(peerId, senderDid, envelope);
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
    if (did && room) {
      updateParticipantLastSeen(room, did).catch(() => {});
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
        _handleRoomName(msg, room);
        break;
      case MessageType.JoinRoom:
        _handleJoinRoom(peerId, msg.peerId, room);
        break;
      case MessageType.LeaveRoom:
        _handleLeaveRoom(peerId, msg.peerId, room);
        break;
      case MessageType.RoomUsersSync:
        _handleRoomUsersSync(msg, room);
        break;
      case MessageType.SyncDigest:
        _handleDigest(peerId, msg.roomCode, msg.watermarks).catch(() => {});
        break;
      case MessageType.SyncBatch:
        _handleSyncBatch(msg.roomCode, msg.messages).catch(() => {});
        break;
      case MessageType.SyncComplete:
        _handleSyncComplete(peerId);
        break;
      case MessageType.Text:
      case MessageType.Reply:
      case MessageType.Reaction:
      case MessageType.File:
        // A bare chat message is only legitimate over a room's pubsub topic
        // (room !== null). The same message type arriving over a direct
        // stream (room === null) would otherwise be stamped with whatever
        // room the receiver has open - letting any connected peer inject
        // forged history into a room they never joined. Drop it.
        if (room === null) {
          console.warn(
            "[app] dropped direct-stream chat message from",
            msg.senderId
          );
          break;
        }
        _verifyIncoming(msg)
          .then((ok) => {
            if (ok) _handleChatMessage(msg, room, peerId);
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
  // Fetch fresh short-lived TURN credentials for this session (best-effort;
  // falls back to bundled ICE servers if the relay doesn't issue them).
  refreshTurnCredentials().catch(() => {});
  if (_connectPromise) {
    await _connectPromise;
    return;
  }

  _connectPromise = (async () => {
    try {
      // This device's own libp2p key, NOT the identity key: two devices on the
      // same account would otherwise share a peerId and never connect.
      await _transport.connect(deviceKeySeed());
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
    // Ask the peers we are ALREADY connected to for this room's history. The
    // digest only went out when a NEW peer connected, so joining a room while
    // the connections were already up pulled nothing and the room looked empty
    // until a reload rebuilt every connection.
    for (const pid of _transport.peers()) {
      _sendDigest(pid).catch(() => {});
    }
  } catch (err) {
    // Roll back the partial join: _transport.joinRoom() already subscribed the
    // gossipsub topic and we flipped transportState to "in this room" before
    // the awaits that threw. Leaving that half-state makes the room look
    // joined-but-errored. Undo it.
    _transport.leaveRoom(roomCode);
    transportState.connected = false;
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.error = err instanceof Error ? err.message : String(err);
    transportState.connecting = false;
    throw err;
  }
}

export function getRoomUsers(): string[] {
  return transportState.roomUsers;
}

export function leaveRoom(): void {
  void _leaveCurrentRoom();
}

/**
 * Leave the room on screen and nothing else.
 *
 * This used to stop the libp2p node outright and wipe every peer, name, avatar
 * and file transfer: leaving one room of several took down the rooms you were
 * staying in, the call you were on and any transfer in flight, and the app
 * only looked right again after a reload.
 */
async function _leaveCurrentRoom(): Promise<void> {
  const roomCode = transportState.roomCode;
  if (!roomCode) return;
  const selfDid = identityStore.did ?? _transport.selfId();
  if (selfDid) {
    // Await the publish: unsubscribing right after would drop the message and
    // nobody would ever see you leave.
    await _broadcastLeaveRoom().catch(() => {});
    removeRoomParticipant(roomCode, selfDid).catch(() => {});
  }
  _transport.leaveRoom(roomCode);
  // Only hang up if the call is in the room being left.
  if (transportState.callRoomCode === roomCode) leaveCall();

  transportState.roomCode = null;
  transportState.roomName = "";
  transportState.roomUsers = [];
  transportState.messages = [];
  transportState.connected = false;
  transportState.chatMode = "room";
  transportState.activeDmPeerId = null;
}

/** Full teardown: everything goes, including the libp2p node. */
export function disconnectTransport(): void {
  _disconnectWithoutBroadcasting();
}

function _disconnectWithoutBroadcasting(): void {
  for (const transfer of transportState.fileTransfers.values()) {
    if (transfer.blobURL) URL.revokeObjectURL(transfer.blobURL);
  }
  // Clear the file transport's internal maps too - it's a session-long
  // singleton, so without this its stale (revoked) blobURLs get replayed on
  // rejoin and revoke freshly-hydrated ones. Keeps the client alive for reuse.
  _fileTransport.resetTransfers();
  leaveCall();
  _transport.disconnect();
  _peerIdToDid.clear();
  transportState.peerDidVersion += 1;
  // disconnect() fully stops and nulls the libp2p node, so the relay
  // connection is gone too. Without clearing this flag, connect()/joinRoom()
  // short-circuit on the stale `relayConnected === true` and never rebuild
  // the node - reconnect stays broken until a full page reload.
  transportState.relayConnected = false;
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
  noteRoomActivity(msg.roomCode, msg.timestamp);
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
  noteRoomActivity(msg.roomCode, msg.timestamp);
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
  // Reading the version makes callers inside $derived recompute when the map
  // changes: the map itself is a plain Map, so a mapping learned after the
  // "connect" event used to leave presence and profile lookups stale forever.
  void transportState.peerDidVersion;
  return _peerIdToDid.get(peerId) ?? peerId;
}

export function didToPeerId(did: string): string | null {
  void transportState.peerDidVersion;
  for (const [peerId, mappedDid] of _peerIdToDid) {
    if (mappedDid === did) return peerId;
  }
  return null;
}

export function isRelayed(peerId: string): boolean {
  return _transport.isRelayed(peerId);
}
