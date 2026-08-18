/**
 * Reconnect churn: the thing people actually do when testing.
 *
 * This scenario found, in order: the dead outbound stream a reload leaves on
 * the other side, frames vanishing when flushed at stream open, a mutual
 * stream-reset storm, and the final-message hole in purely event-driven sync.
 * Each fix is only real if every cycle here stays green.
 *
 * Reconnect churn: the thing people actually do when testing.
 *
 * A peer leaves and comes back repeatedly while the other keeps talking. Each
 * cycle must end with both sides connected, naming each other, and holding the
 * same history. This is the shape of "my friend was disconnecting and
 * reconnecting and it stopped working properly", including the stale stream a
 * reconnect leaves behind.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForBinding, waitForConvergence, waitForMesh } from "../assert.mjs";

const check = new Check("survives reconnect churn");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("Churn");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await alice.say("before churn");

  for (let cycle = 1; cycle <= 3; cycle++) {
    // Bob drops off entirely, Alice keeps talking into the room.
    await bob.go("/app");
    await alice.say(`while bob away ${cycle}`);
    await sleep(6000);
    console.log(`    alice sees peers=${(await alice.state()).peers} while bob is away`);

    // Bob returns to the room.
    await bob.go("/r/" + room);
    await bob.waitFor("bob back in room", async () =>
      (await bob.eval(`window.__awful?.state.roomCode`)) === room);

    const states = await waitForMesh([alice, bob], 1, { timeout: 60_000 });
    check.ok(true, `cycle ${cycle}: reconnected (peers=${states.map((s) => s.peers).join("/")})`);

    // Both must know who the other is, or presence and profiles are broken.
    // The exchange lands a moment after the connection, so wait for it.
    let identified = true;
    try {
      await waitForBinding([alice, bob], 1, { timeout: 45_000 });
    } catch (err) {
      identified = false;
      console.log("    " + String(err.message).replace(/\n/g, "\n    "));
    }
    check.ok(identified, `cycle ${cycle}: both sides identified each other`);
    console.log(`    alice transport: ${JSON.stringify(await alice.transportStats())}`);
    console.log(`    bob   transport: ${JSON.stringify(await bob.transportStats())}`);
    console.log(`    alice app: ${JSON.stringify(await alice.stats())}`);
    console.log(`    bob   app: ${JSON.stringify(await bob.stats())}`);

    // And the message sent while Bob was away must reach him.
    const agreed = await waitForConvergence([alice, bob], room, { timeout: 60_000 });
    check.ok(
      agreed.includes(`while bob away ${cycle}`),
      `cycle ${cycle}: caught up on what it missed`,
      agreed
    );
  }

  // A message after all that churn must still flow, which is what breaks when
  // a closed stream is left cached.
  await bob.say("after churn");
  const final = await waitForConvergence([alice, bob], room, { timeout: 60_000 });
  check.ok(final.includes("after churn"), "messaging still works afterwards", final);
} finally {
  await closeAll([alice, bob]);
}

check.finish();
