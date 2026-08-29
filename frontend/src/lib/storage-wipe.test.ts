import { describe, expect, it } from "vitest";
import { deleteDB } from "idb";
import { getDB, wipeLocalDatabase } from "./storage";

const timeout = (ms: number, what: string) =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${what} hung`)), ms)
  );

describe("wipeLocalDatabase and the delete-blocking hole", () => {
  it("hands out one connection to concurrent getDB() calls", async () => {
    // An uncached open handle is unreachable - nothing can ever close it, so
    // it blocks a wipe's deleteDatabase forever. Single-flight is what makes
    // "close the cached handle" mean "close every handle we hold".
    const [a, b] = await Promise.all([getDB(), getDB()]);
    expect(a).toBe(b);
  });

  it("yields the cached connection to a delete instead of blocking it", async () => {
    // The production hang: the app is live during a device sync, a write
    // re-opens the database after wipeLocalDatabase() closed its handle, and
    // the delete then waits for exclusive access forever - target frozen at
    // 80%, source at 90%. The blocking() handler must close the cached
    // handle when a delete knocks.
    const db = await getDB();
    await db.put("rooms", {
      roomCode: "r1",
      type: "group",
      name: "held open",
    } as never);

    // Delete WITHOUT closing first, exactly what an orphaned-open race
    // produces. Only the blocking() handler can let this through.
    await Promise.race([deleteDB("awful-chat"), timeout(2_000, "deleteDB")]);
  });

  it("wipes and leaves the database usable for the import that follows", async () => {
    const before = await getDB();
    await before.put("rooms", {
      roomCode: "r2",
      type: "group",
      name: "before wipe",
    } as never);

    await Promise.race([wipeLocalDatabase(), timeout(2_000, "wipe")]);

    const after = await getDB();
    expect(await after.count("rooms")).toBe(0);
    await after.put("rooms", {
      roomCode: "r3",
      type: "group",
      name: "after wipe",
    } as never);
    expect(await after.count("rooms")).toBe(1);
  });
});
