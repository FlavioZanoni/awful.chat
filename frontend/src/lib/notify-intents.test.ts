import { beforeEach, describe, expect, it } from "vitest";
import {
  drainNotifyIntents,
  storeNotifyIntent,
  type NotifyIntent,
} from "./notify-intents";

// fake-indexeddb (from test-setup) backs the raw "awful-notify" DB the
// service worker writes and the app drains.

function intent(overrides: Partial<NotifyIntent> = {}): NotifyIntent {
  return {
    kind: "reply",
    roomCode: "room-1",
    text: "hello",
    ts: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  // Drain whatever a previous test left behind: the store must start empty.
  await drainNotifyIntents();
});

describe("notify intents", () => {
  it("drains stored intents oldest first and clears the store", async () => {
    await storeNotifyIntent(intent({ text: "first" }));
    await storeNotifyIntent(intent({ text: "second", kind: "open" }));

    const drained = await drainNotifyIntents();
    expect(drained.map((i) => i.text)).toEqual(["first", "second"]);
    expect(drained[1].kind).toBe("open");

    expect(await drainNotifyIntents()).toEqual([]);
  });

  it("keeps DM addressing intact", async () => {
    await storeNotifyIntent(
      intent({ dmPeerDid: "did:key:zPeer", roomCode: "dm-x" })
    );
    const [got] = await drainNotifyIntents();
    expect(got.dmPeerDid).toBe("did:key:zPeer");
    expect(got.roomCode).toBe("dm-x");
  });

  it("drops intents older than 24h but still clears them", async () => {
    await storeNotifyIntent(intent({ ts: Date.now() - 25 * 60 * 60 * 1000 }));
    await storeNotifyIntent(intent({ text: "fresh" }));

    const drained = await drainNotifyIntents();
    expect(drained.map((i) => i.text)).toEqual(["fresh"]);
    // The stale one was cleared, not left to reappear.
    expect(await drainNotifyIntents()).toEqual([]);
  });
});
