/**
 * A room you are NOT looking at still reconciles. Digests used to cover only
 * the open room, so a message lost while you were in another room stayed
 * lost until you happened to click in. The repair tick now rotates digests
 * through background rooms - this scenario proves a background room heals
 * with nobody viewing it and no new activity in it.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("background room reconciles unopened");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const roomA = await alice.createRoom("Alpha");
  await bob.joinRoom(roomA);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  const roomB = await alice.createRoom("Beta");
  await bob.joinRoom(roomB);
  check.ok(true, "both peers in two rooms");

  // Alice walks away to room A; bob posts into B while his outbound text and
  // sync frames are dropped, so alice genuinely misses it.
  await alice.openRoom(roomA);
  await bob.faults({
    drop: ["text", "sync_digest", "sync_batch", "sync_complete"],
  });
  await bob.say("beta while alice was away");
  await sleep(3000);
  const before = await alice.stored(roomB);
  check.ok(
    !before.includes("beta while alice was away"),
    "alice genuinely missed the message",
    before
  );

  // Bob also leaves B, then heals. From here neither peer views room B and
  // nothing new happens in it: only the background rotation can repair it.
  await bob.openRoom(roomA);
  await bob.clearFaults();

  const healed = await alice.waitFor(
    "background room healed",
    async () => {
      const stored = await alice.stored(roomB);
      return stored.includes("beta while alice was away") ? stored : null;
    },
    { timeout: 90_000 }
  );
  check.ok(healed.includes("beta while alice was away"),
    "room B reconciled with nobody viewing it");
  const aliceRoom = await alice.eval(`window.__awful.state.roomCode`);
  check.equal(aliceRoom, roomA, "alice never had to open room B");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
