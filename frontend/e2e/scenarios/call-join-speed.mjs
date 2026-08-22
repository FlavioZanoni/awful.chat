/**
 * Joining a call reaches EVERYONE promptly, not one peer now and the rest
 * minutes later.
 *
 * Reported from real use: a friend hopped into a call, connected with one
 * person immediately, and picked up the others about two minutes later. Two
 * things caused that, and neither is in the voice layer - it dials as soon as
 * it knows a peer is in the call AND a peer connection exists.
 *
 *  - Joining a call announced only by gossipsub broadcast, which is best
 *    effort and needs a formed mesh. A dropped announcement was not retried
 *    until the 20s presence heartbeat, and nobody dials a peer they have not
 *    heard is in the call.
 *  - retryMissingRoomPeers doubles its dial wait to a minute. A peer whose
 *    early dials failed sat in that backoff, and nothing reset it when they
 *    turned up in your call. Cumulatively that is about two minutes.
 *
 * Here Carol's dials are blocked long enough for her backoff to grow, which is
 * the state a peer is in after a rocky start, and then she joins the call.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("joining a call reaches every member promptly");
const [alice, bob, carol] = await bootPeers(["Alice", "Bob", "Carol"], {
  ports: [9307, 9308, 9309],
});

try {
  const room = await alice.createRoom("Hop");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  // Carol cannot reach anyone for a while, so her dial backoff grows the way
  // it does after a rocky start on a real network.
  await carol.faults({ blockDial: ["*"] });
  await carol.joinRoom(room);
  await sleep(35_000);
  const blocked = await carol.faultStats();
  check.ok(blocked.blockedDials > 0, "the fault bit: Carol's dials were refused",
    blocked);

  // The others are already talking.
  for (const p of [alice, bob]) {
    await p.clickLabel("Join call");
    await p.waitFor(`${p.name} in call`, () =>
      p.eval(`window.__awful.state.inCall || null`), { timeout: 30_000 });
  }

  // Carol's network comes good and she hops in.
  await carol.clearFaults();
  await carol.clickLabel("Join call");
  await carol.waitFor("carol in call", () =>
    carol.eval(`window.__awful.state.inCall || null`), { timeout: 30_000 });
  const joinedAt = Date.now();

  // Both others must appear in her roster AND have signalled with her. The
  // roster is the thing that used to arrive late, and the counters are the
  // thing that proves a dial crossed. NOT v.links: headless ICE never
  // completes, so a link object is torn down within a second of being built
  // and polling for one is a lottery (learned the hard way in call-late-join,
  // and again here).
  const ids = { alice: await alice.selfId(), bob: await bob.selfId() };
  await carol.waitFor("carol reached BOTH", async () => {
    const v = await carol.voice();
    const both =
      v.roster.includes(ids.alice) && v.roster.includes(ids.bob);
    return both && v.stats.inboundStreams + v.stats.offersSent >= 2
      ? v.stats
      : null;
  }, { timeout: 90_000 });

  const took = Math.round((Date.now() - joinedAt) / 1000);
  check.ok(took <= 45, `everyone was reached in ${took}s, not minutes`);
  check.finish();
} finally {
  await closeAll([alice, bob, carol]);
}
