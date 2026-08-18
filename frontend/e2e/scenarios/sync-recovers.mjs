/**
 * Sync must survive being broken.
 *
 * Drops every digest so history reconciliation silently fails, exchanges
 * messages anyway, then heals the network and requires both peers to converge.
 * This is the shape of "it did not sync the first time and I had to refresh".
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForConvergence, waitForMesh } from "../assert.mjs";

const check = new Check("sync recovers after digests are dropped");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("Sync Test");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  check.ok(true, "two peers connected");

  // Break sync in both directions, then talk past each other.
  await alice.faults({ drop: ["sync_digest", "sync_batch", "sync_complete"] });
  await bob.faults({ drop: ["sync_digest", "sync_batch", "sync_complete"] });

  await alice.say("alice one");
  await bob.say("bob one");
  await sleep(4000);

  // Live gossipsub still delivers, so break that too and post while deaf.
  await alice.faults({
    drop: ["sync_digest", "sync_batch", "sync_complete", "text"],
  });
  await alice.say("alice while deaf");
  await sleep(3000);

  const bobBefore = await bob.stored(room);
  check.ok(
    !bobBefore.includes("alice while deaf"),
    "bob is genuinely missing a message",
    bobBefore
  );
  const stats = await alice.faultStats();
  check.ok(stats.droppedFrames > 0, "the injected fault actually bit", stats);

  // Heal, and require them to agree without anybody reloading.
  await alice.clearFaults();
  await bob.clearFaults();
  await bob.say("bob after heal");

  const agreed = await waitForConvergence([alice, bob], room, { timeout: 90_000 });
  check.ok(agreed.includes("alice while deaf"), "the lost message was recovered", agreed);
  check.equal(
    [...agreed].sort(),
    ["alice one", "alice while deaf", "bob after heal", "bob one"],
    "both peers hold the same history"
  );
} finally {
  await closeAll([alice, bob]);
}

check.finish();
