import {
  getAllRooms,
  getDMRooms,
  putRoom,
  deleteRoom,
  getUnreadCount,
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
}

export const roomsStore = $state<RoomsStore>({
  rooms: [],
  dmRooms: [],
  phonebook: [],
  loading: false,
  unreadCounts: new Map(),
});

export async function loadRooms(): Promise<void> {
  roomsStore.loading = true;
  try {
    const all = await getAllRooms();
    roomsStore.rooms = all.filter((r) => r.type !== "dm") as Room[];
    roomsStore.dmRooms = await getDMRooms();
    roomsStore.phonebook = await getPhonebookEntries();
    await _refreshAllUnread();
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

export async function removeRoom(roomCode: string): Promise<void> {
  await deleteRoom(roomCode);
  roomsStore.rooms = roomsStore.rooms.filter((r) => r.roomCode !== roomCode);
  const next = new Map(roomsStore.unreadCounts);
  next.delete(roomCode);
  roomsStore.unreadCounts = next;
}
