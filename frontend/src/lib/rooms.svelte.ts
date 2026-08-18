import {
  deleteMessagesForRoom,
  getAllRooms,
  getDMRooms,
  putRoom,
  deleteRoom,
  getUnreadCount,
  getMessages,
  getPhonebookEntries,
  type DMRoom,
  type PhonebookEntry,
  type Room,
} from "./storage";
import { identityStore } from "./identity/identity.svelte";

/**
 * Your own messages must never count as unread - they arrive back through
 * sync (another device, or a peer replaying history) with a lamport above your
 * last-seen mark and would otherwise light up a badge for something you wrote.
 * The DM counters already do this; rooms need the same.
 */
function selfSenderId(): string | undefined {
  return identityStore.did ?? undefined;
}

interface RoomsStore {
  rooms: Room[];
  dmRooms: DMRoom[];
  phonebook: PhonebookEntry[];
  loading: boolean;
  unreadCounts: Map<string, number>;
  /** roomCode -> timestamp of the newest message from anyone. */
  lastActivity: Map<string, number>;
}

export const roomsStore = $state<RoomsStore>({
  rooms: [],
  dmRooms: [],
  phonebook: [],
  loading: false,
  unreadCounts: new Map(),
  lastActivity: new Map(),
});

/**
 * Record that a room saw a message, whoever sent it.
 * The sidebar used to show room.createdAt, so the "x minutes ago" line never
 * moved no matter how much was said in the room.
 */
export function noteRoomActivity(roomCode: string, timestamp: number): void {
  if (!roomCode || !timestamp) return;
  if ((roomsStore.lastActivity.get(roomCode) ?? 0) >= timestamp) return;
  const next = new Map(roomsStore.lastActivity);
  next.set(roomCode, timestamp);
  roomsStore.lastActivity = next;
}

export async function loadRooms(): Promise<void> {
  roomsStore.loading = true;
  try {
    const all = await getAllRooms();
    roomsStore.rooms = all.filter((r) => r.type !== "dm") as Room[];
    roomsStore.dmRooms = await getDMRooms();
    roomsStore.phonebook = await getPhonebookEntries();
    await _refreshAllUnread();
    await _refreshAllActivity();
  } finally {
    roomsStore.loading = false;
  }
}

export async function refreshPhonebook(): Promise<void> {
  roomsStore.phonebook = await getPhonebookEntries();
}

export async function refreshDmRooms(): Promise<void> {
  roomsStore.dmRooms = await getDMRooms();
}

export async function refreshUnreadCount(roomCode: string): Promise<void> {
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (!room) return;
  const count = await getUnreadCount(
    roomCode,
    room.lastSeenLamport,
    selfSenderId()
  );
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, count);
  roomsStore.unreadCounts = next;
}

/** Seed the last-activity map from stored history on startup. */
async function _refreshAllActivity(): Promise<void> {
  const entries = await Promise.all(
    roomsStore.rooms.map(async (r) => {
      const msgs = await getMessages(r.roomCode).catch(() => []);
      const last = msgs[msgs.length - 1];
      return [r.roomCode, last?.timestamp ?? r.createdAt] as [string, number];
    })
  );
  roomsStore.lastActivity = new Map(entries);
}

async function _refreshAllUnread(): Promise<void> {
  const entries = await Promise.all(
    roomsStore.rooms.map(async (r) => {
      const count = await getUnreadCount(
        r.roomCode,
        r.lastSeenLamport,
        selfSenderId()
      );
      return [r.roomCode, count] as [string, number];
    })
  );
  roomsStore.unreadCounts = new Map(entries);
}

export async function saveRoom(roomCode: string, name: string): Promise<void> {
  const existing = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (existing) return;

  const room: Room = {
    roomCode,
    name,
    type: "text",
    lastSeenLamport: 0,
    createdAt: Date.now(),
    participants: [],
    participantLastSeen: {},
  };

  await putRoom(room);
  roomsStore.rooms = [...roomsStore.rooms, room];
}

/**
 * Persist a room name learned from a peer (or set locally).
 * Without this a name broadcast only lived in transportState, so the sidebar
 * and the next join still showed the raw room code.
 */
export async function renameRoom(
  roomCode: string,
  name: string
): Promise<void> {
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed || trimmed === roomCode) return;
  const idx = roomsStore.rooms.findIndex((r) => r.roomCode === roomCode);
  if (idx === -1) return;
  if (roomsStore.rooms[idx].name === trimmed) return;
  const updated = { ...roomsStore.rooms[idx], name: trimmed };
  roomsStore.rooms[idx] = updated;
  await putRoom(updated);
}

/**
 * Storage/store half of room removal. On its own this leaves the transport
 * subscribed and the history behind - use removeRoomCompletely() from
 * transport.svelte for the real thing.
 */
export async function removeRoom(roomCode: string): Promise<void> {
  await deleteMessagesForRoom(roomCode);
  await deleteRoom(roomCode);
  roomsStore.rooms = roomsStore.rooms.filter((r) => r.roomCode !== roomCode);
  const unread = new Map(roomsStore.unreadCounts);
  unread.delete(roomCode);
  roomsStore.unreadCounts = unread;
  const activity = new Map(roomsStore.lastActivity);
  activity.delete(roomCode);
  roomsStore.lastActivity = activity;
}
