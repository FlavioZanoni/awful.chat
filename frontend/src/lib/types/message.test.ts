import { describe, expect, it } from "vitest";
import {
  MessageType,
  isChatMessage,
  messageToWire,
  wireToMessage,
  type Message,
} from "./message";

const full: Message = {
  id: "id-1",
  roomCode: "room-x",
  senderId: "did:key:zAlice",
  senderName: "Alice",
  senderDid: "did:key:zAlice",
  sig: "aabb",
  timestamp: 111,
  lamport: 5,
  type: MessageType.Reply,
  content: "hi",
  attachments: ["att-1"],
  replyTo: { id: "id-0", senderName: "Bob", content: "yo" },
  status: "read",
};

describe("wire codec", () => {
  it("messageToWire strips storage-only fields", () => {
    const wire = messageToWire(full);
    expect(wire).not.toHaveProperty("roomCode");
    expect(wire).not.toHaveProperty("attachments");
    expect(wire).not.toHaveProperty("status");
    expect(wire.sig).toBe("aabb");
  });

  it("wireToMessage rebuilds a message for the local room", () => {
    const rebuilt = wireToMessage(messageToWire(full), "other-room");
    expect(rebuilt.roomCode).toBe("other-room");
    expect(rebuilt.attachments).toEqual([]);
    expect(rebuilt.content).toBe(full.content);
    expect(rebuilt.replyTo).toEqual(full.replyTo);
    expect(rebuilt.lamport).toBe(full.lamport);
  });

  it("isChatMessage accepts only persisted chat types", () => {
    expect(isChatMessage(messageToWire(full))).toBe(true);
    expect(
      isChatMessage({ type: MessageType.SyncComplete, roomCode: "r" })
    ).toBe(false);
    expect(
      isChatMessage({
        type: MessageType.Profile,
        name: "x",
        did: null,
        avatarUrl: null,
      })
    ).toBe(false);
  });
});
