import { describe, expect, it } from "vitest";
import { foldComparator } from "./state.svelte";

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
