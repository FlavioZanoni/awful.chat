import { beforeEach, describe, expect, it } from "vitest";
import {
  bulkPutMessages,
  getMessage,
  getMessages,
  getUnreadCount,
  getWatermark,
  getWatermarksForRoom,
  markRoomSeen,
  putMessage,
  putRoom,
  getRoom,
  setWatermark,
  updateMessageStatus,
  wipeLocalDatabase,
  type Room,
} from "./storage";
import { MessageType, type Message } from "./types/message";

let seq = 0;
function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    roomCode: "room-a",
    senderId: "alice",
    senderName: "Alice",
    timestamp: 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `message ${seq}`,
    attachments: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await wipeLocalDatabase();
  seq = 0;
});

describe("watermarks", () => {
  it("stores and reads per-sender max lamport", async () => {
    await setWatermark("room-a", "alice", 5);
    expect(await getWatermark("room-a", "alice")).toBe(5);
  });

  it("never regresses", async () => {
    await setWatermark("room-a", "alice", 10);
    await setWatermark("room-a", "alice", 3);
    expect(await getWatermark("room-a", "alice")).toBe(10);
  });

  it("collects all senders for a room", async () => {
    await setWatermark("room-a", "alice", 4);
    await setWatermark("room-a", "bob", 9);
    await setWatermark("room-b", "carol", 1);
    expect(await getWatermarksForRoom("room-a")).toEqual({
      alice: 4,
      bob: 9,
    });
  });
});

describe("message status", () => {
  it("advances forward", async () => {
    const m = msg({ status: "sending" });
    await putMessage(m);
    await updateMessageStatus(m.id, "delivered");
    expect((await getMessage(m.id))?.status).toBe("delivered");
  });

  it("never regresses (late delivered ack after read)", async () => {
    const m = msg({ status: "read" });
    await putMessage(m);
    await updateMessageStatus(m.id, "delivered");
    expect((await getMessage(m.id))?.status).toBe("read");
  });

  it("ignores unknown message ids", async () => {
    await expect(
      updateMessageStatus("nope", "delivered")
    ).resolves.toBeUndefined();
  });
});

describe("unread counts and seen tracking", () => {
  const room: Room = {
    roomCode: "room-a",
    type: "text",
    name: "Room A",
    lastSeenLamport: 0,
    createdAt: 0,
    participants: [],
  };

  it("counts messages past the seen watermark", async () => {
    await putRoom(room);
    await bulkPutMessages([msg(), msg(), msg()]); // lamports 1..3
    expect(await getUnreadCount("room-a", 0)).toBe(3);
    expect(await getUnreadCount("room-a", 2)).toBe(1);
  });

  it("excludes own messages when asked", async () => {
    await putRoom(room);
    await bulkPutMessages([
      msg({ senderId: "me" }),
      msg({ senderId: "alice" }),
    ]);
    expect(await getUnreadCount("room-a", 0, "me")).toBe(1);
  });

  it("markRoomSeen persists the watermark", async () => {
    await putRoom(room);
    await markRoomSeen("room-a", 42);
    expect((await getRoom("room-a"))?.lastSeenLamport).toBe(42);
  });
});

describe("message pagination", () => {
  it("pages by lamport descending window, returned ascending", async () => {
    await bulkPutMessages(
      Array.from({ length: 60 }, () => msg())
    );
    const page = await getMessages("room-a");
    expect(page).toHaveLength(50);
    expect(page[0].lamport).toBe(11);
    expect(page[49].lamport).toBe(60);

    const older = await getMessages("room-a", 11);
    expect(older).toHaveLength(10);
    expect(older[older.length - 1].lamport).toBe(10);
  });
});
