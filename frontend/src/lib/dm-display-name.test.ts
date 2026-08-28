import { describe, it, expect } from "vitest";
import { resolveDmRoomDisplayName } from "./dm-display-name";
import type { DMRoom, PhonebookEntry } from "./storage";

describe("resolveDmRoomDisplayName", () => {
  const phonebook: PhonebookEntry[] = [
    {
      peerId: "peer-alice",
      did: "did:key:alice123",
      nickname: "Alice",
      addedAt: Date.now(),
    },
    {
      peerId: "peer-bob",
      did: "did:key:bob456",
      nickname: "Bob",
      addedAt: Date.now(),
    },
    {
      peerId: "legacy-charlie",
      nickname: "Charlie",
      addedAt: Date.now(),
    },
  ];

  const dmRoom: DMRoom = {
    roomCode: "dm-076c3e9ad1c82389822b67795950b1fe11dc5a63",
    type: "dm",
    name: "",
    lastSeenLamport: 0,
    createdAt: Date.now(),
    participants: ["did:key:alice123"],
    participantLastSeen: {},
    participantDid: "did:key:alice123",
  };

  it("returns unchanged room code for non-DM rooms", () => {
    const result = resolveDmRoomDisplayName(
      "general",
      null,
      phonebook
    );
    expect(result).toBe("general");
  });

  it("resolves DM room to counterparty's nickname when found in phonebook", () => {
    const result = resolveDmRoomDisplayName(
      dmRoom.roomCode,
      dmRoom,
      phonebook
    );
    expect(result).toBe("Alice");
  });

  it("falls back to truncated code when DM has no phonebook entry", () => {
    const unknownDmRoom: DMRoom = {
      ...dmRoom,
      participantDid: "did:key:unknown999",
    };
    const result = resolveDmRoomDisplayName(
      dmRoom.roomCode,
      unknownDmRoom,
      phonebook
    );
    expect(result).toBe("dm-076c3e9ad");
  });

  it("falls back to truncated code when DM room data is missing", () => {
    const result = resolveDmRoomDisplayName(
      dmRoom.roomCode,
      null,
      phonebook
    );
    expect(result).toBe("dm-076c3e9ad");
  });

  it("falls back to truncated code when DM room has no participantDid", () => {
    const incompleteDmRoom: DMRoom = {
      ...dmRoom,
      participantDid: "",
    };
    const result = resolveDmRoomDisplayName(
      dmRoom.roomCode,
      incompleteDmRoom,
      phonebook
    );
    expect(result).toBe("dm-076c3e9ad");
  });

  it("finds phonebook entry by DID even with legacy peerId-keyed entries", () => {
    const bobRoom: DMRoom = {
      ...dmRoom,
      roomCode: "dm-081bd2642f0baafd2c8e0455f3dd6357256a0fbf",
      participantDid: "did:key:bob456",
    };
    const result = resolveDmRoomDisplayName(
      bobRoom.roomCode,
      bobRoom,
      phonebook
    );
    expect(result).toBe("Bob");
  });

  it("truncates DM code to 12 characters as fallback", () => {
    const longCode = "dm-076c3e9ad1c82389822b67795950b1fe11dc5a63abc";
    const result = resolveDmRoomDisplayName(
      longCode,
      null,
      phonebook
    );
    expect(result).toBe("dm-076c3e9ad");
    expect(result.length).toBe(12);
  });
});
