/**
 * Backfilled history older than what is on screen has to become visible
 * WITHOUT a reload.
 *
 * The view is only ever re-read from storage by _loadHistory and
 * loadMoreMessages; every other path splices into the in-memory list. A sync
 * batch is spliced in only when its lamport is at or above the oldest message
 * currently loaded, so history that arrives late and belongs BELOW that floor
 * lands in IndexedDB and is never rendered. It is not reachable by scrolling
 * either - the "Load older" control only draws once 50 messages are on screen -
 * so the only way to see it is a reload. That is the "history does not sync
 * until I ctrl+shift+R" report, reproduced here without any caching involved.
 *
 * Alice's sync batches are dropped while Bob builds a view out of live
 * messages only, so his window floor sits above the backlog he is missing.
 * Healing the fault then delivers exactly the below-the-floor case.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const view = (p) =>
  p.json(`JSON.stringify(window.__awful.state.messages.map((m) => m.content))`);

const check = new Check("late backfill below the window renders without a reload");
const [alice, bob, carol] = await bootPeers(["Alice", "Bob", "Carol"], {
  ports: [9307, 9308, 9309],
});

try {
  const room = await alice.createRoom("Backfill");
  await carol.joinRoom(room);
  await waitForMesh([alice, carol], 1);
  await waitForBinding([alice, carol], 1);

  // Alice's backlog. Carol takes a copy; Bob must not get one.
  for (const t of ["old 1", "old 2", "old 3"]) await alice.say(t);
  await carol.waitFor("carol has the backlog", async () =>
    (await carol.stored(room)).includes("old 3") || null, { timeout: 45_000 });

  // Nobody may answer Bob's digest for now. It has to be BOTH holders, or the
  // other one simply serves the backlog and there is nothing to reproduce.
  await alice.faults({ drop: ["sync_batch"] });
  await carol.faults({ drop: ["sync_batch"] });

  await bob.joinRoom(room);
  await waitForMesh([alice, bob, carol], 2);
  await waitForBinding([alice, bob, carol], 2);

  // Live messages still reach Bob (gossipsub, not a batch). Crucially they are
  // CAROL's: Bob ends up with a watermark for Carol and none for Alice, which
  // is what lets Alice's older messages be offered later. A single scalar
  // watermark per sender cannot say "I have 4,5,6 but not 1,2,3", so backfill
  // below the floor only ever arrives from a sender you have not heard from.
  for (const t of ["new 1", "new 2", "new 3"]) await carol.say(t);
  await bob.waitFor("bob has the live ones", async () => {
    const v = await view(bob);
    return v.includes("new 3") ? v : null;
  }, { timeout: 45_000 });

  const before = await view(bob);
  check.ok(
    !before.includes("old 1"),
    "the fault bit: Bob is genuinely missing Alice's backlog",
    before
  );

  // Re-open so _loadHistory sets the window floor from the live messages. The
  // reload is the PRECONDITION, not the thing under test - the assertion at
  // the end is that no FURTHER reload is needed.
  await bob.go(`/r/${room}`);
  await bob.waitFor("back in the room", async () =>
    (await bob.eval(`window.__awful?.state.roomCode`)) === room || null,
    { timeout: 45_000 });
  const floorView = await view(bob);
  check.ok(
    !floorView.includes("old 1") && floorView.includes("new 3"),
    "the window floor sits above the missing backlog",
    floorView
  );

  await alice.clearFaults();
  await carol.clearFaults();

  // Storage catches up: this half already worked.
  await bob.waitFor("backlog reaches storage", async () =>
    (await bob.stored(room)).includes("old 1") || null, { timeout: 90_000 });
  check.ok(true, "the backlog arrives and is stored");

  // ...and this half did not. No reload anywhere after the floor was set.
  const shown = await bob
    .waitFor("backlog becomes visible", async () => {
      const v = await view(bob);
      return v.includes("old 1") && v.includes("old 3") ? v : null;
    }, { timeout: 45_000 })
    .catch(async () => await view(bob));
  check.ok(
    shown.includes("old 1") && shown.includes("old 3"),
    "the backlog is on screen without a reload",
    { view: shown, stored: await bob.stored(room) }
  );

  check.finish();
} finally {
  await closeAll([alice, bob, carol]);
}
