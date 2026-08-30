import { beforeEach, describe, expect, it } from "vitest";
import {
  getSearchIndex,
  putMessage,
  wipeLocalDatabase,
  getNewestLamportOfTypes,
} from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import {
  clearSearchCorpus,
  ensureRoomCorpus,
  searchRooms,
  scopeProgress,
} from "./corpus.svelte";
import { parseSearchQuery } from "./query";

const TEST_KEY = new Uint8Array(32).fill(7);
let seq = 0;

function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    roomCode: "room-a",
    senderId: "alice-id",
    senderDid: "did:key:alice",
    senderName: "Alice",
    timestamp: Date.now() - 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `message ${seq}`,
    attachments: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await initStorageCrypto(TEST_KEY);
  await wipeLocalDatabase();
  clearSearchCorpus();
  seq = 0;
});

describe("search corpus", () => {
  it("sweeps a room and finds messages", async () => {
    await putMessage(msg({ content: "the deploy went fine" }));
    await putMessage(msg({ content: "unrelated chatter" }));
    await ensureRoomCorpus("room-a");

    const hits = searchRooms(parseSearchQuery("deploy"), ["room-a"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.text).toContain("deploy");
    expect(scopeProgress(["room-a"]).done).toBe(true);
  });

  it("writes a sealed index the next session reuses", async () => {
    await putMessage(msg({ content: "needle in the haystack" }));
    await ensureRoomCorpus("room-a");

    const record = await getSearchIndex("room-a");
    expect(record).toBeDefined();
    expect(record!.lastLamport).toBe(
      await getNewestLamportOfTypes("room-a", [MessageType.Text])
    );

    // "Next session": memory gone, index row still there.
    clearSearchCorpus();
    await ensureRoomCorpus("room-a");
    const hits = searchRooms(parseSearchQuery("needle"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("detects a stale index and re-sweeps", async () => {
    await putMessage(msg({ content: "first" }));
    await ensureRoomCorpus("room-a");
    clearSearchCorpus();

    // A message stored while no corpus is warm: the sealed index has not
    // flushed (3s debounce), so lastLamport is behind the messages store.
    await putMessage(msg({ content: "the fresh needle" }));
    await ensureRoomCorpus("room-a");
    const hits = searchRooms(parseSearchQuery("fresh needle"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("live-appends stored messages into a warm corpus", async () => {
    await ensureRoomCorpus("room-a");
    await putMessage(msg({ content: "landed after the sweep" }));
    const hits = searchRooms(parseSearchQuery("landed"), ["room-a"]);
    expect(hits).toHaveLength(1);
  });

  it("excludes non-searchable types", async () => {
    await putMessage(
      msg({ type: MessageType.Reaction, content: "thumbs", reactionTo: "x" })
    );
    await ensureRoomCorpus("room-a");
    expect(searchRooms(parseSearchQuery("thumbs"), ["room-a"])).toHaveLength(0);
  });
});
