import { beforeEach, describe, expect, it, vi } from "vitest";

function stubStorage(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("pinned widget prefs", () => {
  it("migrates v1 card pins to unique plugin pins", async () => {
    stubStorage({
      "awful:plugin-widgets:v1": JSON.stringify([
        { pluginId: "waffle-party", cardId: "c1", roomCode: "r1" },
        { pluginId: "waffle-party", cardId: "c2", roomCode: "r2" },
        { pluginId: "poll", cardId: "c3", roomCode: "r1" },
      ]),
    });
    const { pluginPrefs } = await import("./prefs.svelte");
    expect(pluginPrefs.pinnedWidgets).toEqual([
      { pluginId: "waffle-party" },
      { pluginId: "poll" },
    ]);
  });

  it("pins one entry per plugin and evicts the oldest at capacity", async () => {
    stubStorage({});
    const { pinWidget, pluginPrefs } = await import("./prefs.svelte");
    pinWidget("a");
    pinWidget("b");
    pinWidget("a"); // re-pin moves, never duplicates
    pinWidget("c");
    pinWidget("d"); // capacity 3: oldest ("b") makes room
    expect(pluginPrefs.pinnedWidgets.map((p) => p.pluginId)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("unpins by plugin id and persists", async () => {
    const store = stubStorage({});
    const { pinWidget, unpinWidget } = await import("./prefs.svelte");
    pinWidget("a");
    unpinWidget("a");
    expect(JSON.parse(store.get("awful:plugin-widgets:v2")!)).toEqual([]);
  });
});
