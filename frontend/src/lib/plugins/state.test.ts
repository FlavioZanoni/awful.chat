import { describe, expect, it } from "vitest";
import { cardStates, foldComparator, foldUpdate } from "./state.svelte";
import type { PluginDefinition } from "./api";

describe("foldComparator", () => {
  it("orders by lamport first", () => {
    const a = { lamport: 1, senderId: "b", id: "1" };
    const b = { lamport: 2, senderId: "a", id: "2" };
    expect(foldComparator(a, b)).toBeLessThan(0);
    expect(foldComparator(b, a)).toBeGreaterThan(0);
  });

  it("orders by senderId when lamports are equal", () => {
    const a = { lamport: 1, senderId: "alice", id: "1" };
    const b = { lamport: 1, senderId: "bob", id: "2" };
    expect(foldComparator(a, b)).toBeLessThan(0);
    expect(foldComparator(b, a)).toBeGreaterThan(0);
  });

  it("orders by id when lamports and senderIds are equal", () => {
    const a = { lamport: 1, senderId: "alice", id: "a" };
    const b = { lamport: 1, senderId: "alice", id: "b" };
    expect(foldComparator(a, b)).toBeLessThan(0);
    expect(foldComparator(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for identical messages", () => {
    const a = { lamport: 1, senderId: "alice", id: "a" };
    expect(foldComparator(a, a)).toBe(0);
  });

  it("maintains total ordering across multiple items", () => {
    const items = [
      { lamport: 3, senderId: "b", id: "1" },
      { lamport: 1, senderId: "c", id: "2" },
      { lamport: 1, senderId: "a", id: "3" },
      { lamport: 2, senderId: "b", id: "4" },
    ];

    const sorted = [...items].sort(foldComparator);

    expect(sorted[0].lamport).toBe(1);
    expect(sorted[0].senderId).toBe("a");
    expect(sorted[1].lamport).toBe(1);
    expect(sorted[1].senderId).toBe("c");
    expect(sorted[2].lamport).toBe(2);
    expect(sorted[3].lamport).toBe(3);
  });
});

describe("foldUpdate ordering", () => {
  // A reducer where order is visible: it appends every update id it accepts.
  const recorder = {
    id: "t",
    name: "t",
    version: "1",
    initialState: () => [] as string[],
    reduce: (s: unknown, u: { data: unknown }) => [
      ...(s as string[]),
      u.data as string,
    ],
  } as unknown as PluginDefinition;

  const upd = (id: string, lamport: number, ephemeral = false) => ({
    id,
    senderId: "s",
    senderName: "S",
    lamport,
    data: id,
    ephemeral,
  });

  it("folds in-order updates incrementally and advances the entry", () => {
    cardStates.set("c1", { state: ["a"], last: { lamport: 1, senderId: "s", id: "a" } });
    const out = foldUpdate("c1", recorder, upd("b", 2));
    expect(out).toEqual(["a", "b"]);
    expect(cardStates.get("c1")?.last?.lamport).toBe(2);
    cardStates.delete("c1");
  });

  it("evicts on an out-of-order arrival instead of folding on top", () => {
    // Two concurrent spins: lamport 9 arrives AFTER 10 was already folded.
    // Folding it on top applies the wrong order (each client would keep its
    // own winner); the entry must be dropped so storage replays globally.
    cardStates.set("c2", { state: ["ten"], last: { lamport: 10, senderId: "s", id: "ten" } });
    const out = foldUpdate("c2", recorder, upd("nine", 9));
    expect(out).toBeUndefined();
    expect(cardStates.has("c2")).toBe(false);
  });

  it("ephemerals (lamport 0) fold without eviction and never move the cursor", () => {
    cardStates.set("c3", { state: ["a"], last: { lamport: 5, senderId: "s", id: "a" } });
    const out = foldUpdate("c3", recorder, upd("fx", 0, true));
    expect(out).toEqual(["a", "fx"]);
    expect(cardStates.get("c3")?.last?.lamport).toBe(5);
    expect(cardStates.has("c3")).toBe(true);
    cardStates.delete("c3");
  });
});
