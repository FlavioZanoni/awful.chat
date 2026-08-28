import type { DMRoom, PhonebookEntry } from "./storage";

/**
 * Resolve a display name for a DM room.
 *
 * For DM rooms, looks up the counterparty's phonebook entry by their DID
 * and returns their nickname. Falls back to a truncated room code if no
 * phonebook entry is found. Non-DM rooms return unchanged.
 *
 * @param roomCode - The room's code (starts with "dm-" for direct messages)
 * @param dmRoom - Optional DMRoom object with participantDid
 * @param phonebookEntries - Array of phonebook entries to search
 * @returns The display name (nickname, truncated code, or original name)
 */
export function resolveDmRoomDisplayName(
  roomCode: string,
  dmRoom: DMRoom | null | undefined,
  phonebookEntries: PhonebookEntry[]
): string {
  // Non-DM rooms return the code unchanged - the caller should use room.name
  // if available, or this function will preserve the original.
  if (!roomCode.startsWith("dm-")) {
    return roomCode;
  }

  // No DM room data means we can't look up participantDid.
  // Fall back to a truncated code.
  if (!dmRoom?.participantDid) {
    return roomCode.slice(0, 12);
  }

  // Look up the phonebook entry by the participant's DID.
  // Try DID first (most recent), then peerId for legacy entries.
  const entry = phonebookEntries.find(
    (e) => e.did === dmRoom.participantDid || e.peerId === dmRoom.participantDid
  );

  // Return nickname if found, otherwise truncate the code.
  if (entry?.nickname) {
    return entry.nickname;
  }

  return roomCode.slice(0, 12);
}
