import { identityStore } from "$lib/identity/identity.svelte";
import { refreshDmRooms } from "$lib/rooms.svelte";
import {
  deleteMessagesForRoom,
  deletePhonebookEntry,
  deleteRoom,
  getDMRooms,
  getPeerProfile,
  getPhonebookEntries,
  getRoom,
  putMessage,
  putPhonebookEntry,
  putRoom,
  type DMRoom,
} from "$lib/storage";
import { MessageType, type Message } from "$lib/types/message";
import { signMessage } from "$lib/messaging";
import {
  _loadHistory,
  _peerIdToDid,
  _transport,
  applyMessageStatus,
  transportState,
} from "./transport.svelte";
import {
  looksLikePeerId,
  looksLikeDid,
  resolveToDid,
  didToPeerId,
} from "$lib/identity/identity-utils";

import {
  encodeDmChatEnvelope,
  encodeDmReadEnvelope,
  hashDmRoomCode,
} from "./dm-codec";

interface QueuedMessage {
  to: string;
  data: number[];
  queuedAt: number;
  messageId?: string; // for status updates once the flush succeeds
}

const DM_QUEUE_KEY = "awful:dm-queue:v1";

function loadQueuedDmMessages(): QueuedMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(DM_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.to === "string" &&
        Array.isArray(item.data) &&
        typeof item.queuedAt === "number"
    ) as QueuedMessage[];
  } catch {
    return [];
  }
}

function saveQueuedDmMessages(queue: QueuedMessage[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(DM_QUEUE_KEY, JSON.stringify(queue));
}

function resolveDmPeerId(candidate: string): string | null {
  if (!candidate) return null;
  // If it's a current peer, use it
  if (_transport.peers().includes(candidate)) return candidate;
  // If it looks like a peer ID, use it
  if (looksLikePeerId(candidate)) return candidate;
  // If it's a DID, try to find the peer ID, but if not found, use the DID itself
  // This is important because DIDs are stable identities
  if (looksLikeDid(candidate)) {
    for (const [peerId, did] of _peerIdToDid) {
      if (did === candidate) return peerId;
    }
    // No mapping found, but it's a valid DID - return it as-is
    // The room code will be computed from the DID which is stable
    return candidate;
  }
  // Try reverse lookup for DID→peerId
  for (const [peerId, did] of _peerIdToDid) {
    if (did === candidate) return peerId;
  }
  return null;
}

function queueDmMessage(
  toDid: string,
  data: Uint8Array,
  messageId?: string
): void {
  const queue = loadQueuedDmMessages();
  queue.push({
    to: toDid,
    data: Array.from(data),
    queuedAt: Date.now(),
    messageId,
  });
  saveQueuedDmMessages(queue);
}

export async function dmConversationCodeFor(
  peerIdOrDid: string
): Promise<string> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  return dmConversationCodeAsync(resolvedPeerId);
}

/**
 * Get the stable DM room code for a conversation with a peer.
 * Uses DIDs (stable identity) not peer IDs (ephemeral).
 */
async function dmConversationCodeAsync(peerIdOrDid: string): Promise<string> {
  const selfDid = identityStore.did ?? _transport.selfId();
  // Resolve to DID if we have a mapping, otherwise use as-is
  const peerDid = _peerIdToDid.get(peerIdOrDid) ?? peerIdOrDid;
  return hashDmRoomCode(selfDid, peerDid);
}

export async function openDmConversation(peerIdOrDid: string): Promise<void> {
  if (!_transport.selfId()) return;
  // Use the input as-is if we can't resolve to a peer ID
  // This supports opening DMs with DIDs directly
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  if (!resolvedPeerId) return;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  _transport.joinRoom(roomCode);
  await _loadHistory(roomCode);
  transportState.chatMode = "dm";
  transportState.activeDmPeerId = resolvedPeerId;
  transportState.roomCode = roomCode;
  transportState.roomName = resolveDmDisplayName(resolvedPeerId);
  transportState.connected = true;

  // Everything now on screen counts as read — tell the sender.
  const selfDid = identityStore.did ?? _transport.selfId();
  const theirMessageIds = transportState.messages
    .filter((m) => m.roomCode === roomCode && m.senderId !== selfDid)
    .map((m) => m.id);
  sendDmReadAcks(resolvedPeerId, theirMessageIds);
}

export async function sendDirectMessage(text: string): Promise<void> {
  const peerId = transportState.activeDmPeerId;
  if (!peerId) return;
  const body = text.trim();
  if (!body) return;

  const roomCode = await ensureDmRoomForPeer(peerId);
  _transport.joinRoom(roomCode);

  const id = crypto.randomUUID();
  const ts = Date.now();
  const envelope = encodeDmChatEnvelope({ id, text: body, ts });

  const peerDid = _peerIdToDid.get(peerId) ?? peerId;

  // Resolve to an actual peer ID (not a DID) before checking online status.
  // resolveDmPeerId already handles peerId→peerId and DID→peerId via _peerIdToDid,
  // but falls back to the DID itself when no mapping exists. We need a real peer ID
  // to check _transport.peers(), so we try didToPeerId as a second pass.
  let resolvedPeerId = resolveDmPeerId(peerId);
  if (resolvedPeerId && looksLikeDid(resolvedPeerId)) {
    resolvedPeerId =
      didToPeerId(resolvedPeerId, _peerIdToDid) ?? resolvedPeerId;
  }

  const isOnline =
    !!resolvedPeerId &&
    !looksLikeDid(resolvedPeerId) &&
    _transport.peers().includes(resolvedPeerId);

  let delivered = false;
  if (isOnline) {
    delivered = await _transport.send(resolvedPeerId!, envelope);
  }
  if (!delivered) queueDmMessage(peerDid, envelope, id);

  const mySenderId = identityStore.did ?? _transport.selfId();
  let msg: Message = {
    id,
    roomCode,
    senderId: mySenderId,
    senderName: "You",
    timestamp: ts,
    lamport: ts,
    type: MessageType.Text,
    content: body,
    attachments: [],
    // "sending" = queued locally, "sent" = handed to the transport;
    // "delivered"/"read" arrive later via acks
    status: delivered ? "sent" : "sending",
  };

  // Sign the message before storing
  msg = signMessage(msg);

  await putMessage(msg);
  await refreshDmRooms();
  transportState.dmVersion += 1;
  if (
    transportState.chatMode === "dm" &&
    transportState.activeDmPeerId === peerId
  ) {
    transportState.messages = [...transportState.messages, msg].sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }
}

/**
 * Send read acks to a peer for messages we just displayed.
 * Fire-and-forget: if the peer is offline the acks are simply dropped —
 * they'll be re-sent the next time the conversation is opened while
 * both peers are online (idempotent on the receiving side).
 */
export function sendDmReadAcks(peerId: string, messageIds: string[]): void {
  if (!messageIds.length) return;
  let resolved = resolveDmPeerId(peerId);
  if (resolved && looksLikeDid(resolved)) {
    resolved = didToPeerId(resolved, _peerIdToDid) ?? resolved;
  }
  if (!resolved || looksLikeDid(resolved)) return;
  if (!_transport.peers().includes(resolved)) return;
  _transport.send(resolved, encodeDmReadEnvelope(messageIds)).catch(() => {});
}

// Flushes are serialized and sent entries are removed against a FRESH read
// of the queue: a snapshot write-back would clobber messages queued (for any
// peer) while the awaited sends were in flight.
let _flushChain: Promise<void> = Promise.resolve();

export function flushQueuedDmForPeer(peerId: string): Promise<void> {
  _flushChain = _flushChain.then(() => _flushQueuedDmForPeer(peerId));
  return _flushChain;
}

function queueEntryKey(e: QueuedMessage): string {
  return `${e.to}|${e.queuedAt}|${e.messageId ?? ""}`;
}

async function _flushQueuedDmForPeer(peerId: string): Promise<void> {
  const peerDid = _peerIdToDid.get(peerId);
  if (!peerDid) return; // Can't flush if we don't know their DID yet

  const sent = new Set<string>();
  for (const entry of loadQueuedDmMessages()) {
    if (entry.to !== peerDid) continue;
    const ok = await _transport.send(peerId, new Uint8Array(entry.data));
    if (ok) {
      sent.add(queueEntryKey(entry));
      if (entry.messageId) applyMessageStatus(entry.messageId, "sent");
    }
  }
  if (sent.size === 0) return;
  saveQueuedDmMessages(
    loadQueuedDmMessages().filter((e) => !sent.has(queueEntryKey(e)))
  );
}

export function resolveDmDisplayName(peerId: string): string {
  const did = _peerIdToDid.get(peerId);
  if (did)
    return (
      transportState.peerNames.get(did) ??
      transportState.peerNames.get(peerId) ??
      peerId.slice(0, 12)
    );
  return transportState.peerNames.get(peerId) ?? peerId.slice(0, 12);
}

export async function joinPhonebookDmRooms(): Promise<void> {
  const selfDid = identityStore.did ?? _transport.selfId();
  if (!selfDid) return;
  const entries = await getPhonebookEntries();
  for (const entry of entries) {
    const peerDid = resolveToDid(entry.peerId, _peerIdToDid);
    const roomCode = await hashDmRoomCode(selfDid, peerDid);
    _transport.joinRoom(roomCode);
  }
}

export async function ensureDmRoomForPeer(
  peerIdOrDid: string
): Promise<string> {
  const peerDid = resolveToDid(peerIdOrDid, _peerIdToDid);
  const roomCode = await dmConversationCodeAsync(peerIdOrDid);
  const existing = await getRoom(roomCode);
  if (existing) return roomCode;
  const room: DMRoom = {
    roomCode,
    type: "dm",
    name: "",
    lastSeenLamport: 0,
    createdAt: Date.now(),
    participants: [peerDid],
    participantLastSeen: {},
    participantDid: peerDid,
  };
  await putRoom(room);
  return roomCode;
}

export async function addToPhonebook(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid);
  if (!resolvedPeerId) return;
  const roomCode = await ensureDmRoomForPeer(resolvedPeerId);
  const did = _peerIdToDid.get(resolvedPeerId);
  const profile = did ? await getPeerProfile(did) : undefined;
  await putPhonebookEntry({
    peerId: resolvedPeerId,
    did: did ?? resolvedPeerId,
    nickname: profile?.nickname || resolveDmDisplayName(resolvedPeerId),
    addedAt: Date.now(),
  });
  _transport.joinRoom(roomCode);
}

export async function removeFromPhonebook(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  await deletePhonebookEntry(resolvedPeerId);
}

export async function removeDmConversation(peerIdOrDid: string): Promise<void> {
  const resolvedPeerId = resolveDmPeerId(peerIdOrDid) ?? peerIdOrDid;
  const allDmRooms = await getDMRooms();

  // Get the canonical room code for this peer
  const canonicalRoomCode = await dmConversationCodeAsync(resolvedPeerId);
  const candidates = new Set<string>([canonicalRoomCode]);

  // Also check rooms by participantDid match
  for (const room of allDmRooms) {
    if (
      room.participantDid === resolvedPeerId ||
      room.participantDid === peerIdOrDid
    ) {
      candidates.add(room.roomCode);
    }
  }

  const queue = loadQueuedDmMessages();
  saveQueuedDmMessages(queue.filter((q) => q.to !== resolvedPeerId));

  // Delete messages for all matching rooms, then delete the rooms
  await Promise.all(
    [...candidates].map(async (roomCode) => {
      await deleteMessagesForRoom(roomCode);
      await deleteRoom(roomCode);
    })
  );

  if (
    transportState.chatMode === "dm" &&
    transportState.activeDmPeerId === resolvedPeerId
  ) {
    transportState.activeDmPeerId = null;
    transportState.roomCode = null;
    transportState.roomName = "";
    transportState.messages = [];
    transportState.chatMode = "room";
    transportState.connected = false;
  }

  transportState.dmVersion += 1;
}
