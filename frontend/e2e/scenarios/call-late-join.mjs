/**
 * Joining a call over a connection that is already up gets you audio.
 *
 * Voice links used to be created only on a libp2p "connect" event or in the
 * one-shot sweep inside voice.join(), and only one side of a pair dials (the
 * higher peerId). So when the peer who joins the call SECOND is the lower id,
 * nobody dialled: the late joiner's sweep skipped the higher id, and the peer
 * already in the call never saw a connect event because the connection had
 * been up since they entered the room. Leaving and rejoining the call was the
 * only cure, which is exactly the bug this asserts is gone.
 *
 * The join order here is chosen from the real peerIds so the broken case is
 * hit every run instead of on a coin flip.
 *
 * Media does not reliably complete between two headless browsers, so this
 * asserts the link EXISTS on both sides, not that it reached "connected". The
 * passive side only ever builds one from an inbound /voice/1.0.0 stream, so a
 * link there is proof the dial actually crossed the wire.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("late call join still gets a voice link");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("LateJoin");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  const ids = {
    alice: await alice.selfId(),
    bob: await bob.selfId(),
  };
  // The higher id is the one that dials, so it must be the one ALREADY in the
  // call when the other joins - that is the combination that used to fail.
  const [dialer, waiter] =
    ids.alice > ids.bob ? [alice, bob] : [bob, alice];
  const dialerId = ids.alice > ids.bob ? ids.alice : ids.bob;
  const waiterId = ids.alice > ids.bob ? ids.bob : ids.alice;
  console.log(`  (dialer=${dialer.name} joins first, waiter=${waiter.name} joins second)`);

  await dialer.clickLabel("Join call");
  await dialer.waitFor("dialer in call", () =>
    dialer.eval(`window.__awful.state.inCall || null`));

  // Alone in the call: nobody to link to, and the roster says so.
  const alone = await dialer.voice();
  check.equal(alone.roster, [], "alone in the call, the voice roster is empty");

  // Let the first joiner go quiet before the second one arrives. This is the
  // difference between testing the fix and testing a coincidence: the old code
  // dialled once at join time and retried for about nine seconds, which is
  // long enough to accidentally cover a late joiner who turns up immediately.
  // The real complaint is people joining a call minutes apart, so wait until
  // the dialer has stopped trying - either it never started (it has an empty
  // roster, which is the fixed behaviour) or its retries have been exhausted.
  await dialer.waitFor("dialer quiescent", async () => {
    const st = (await dialer.voice()).stats;
    return st.dialsStarted === 0 || st.dialsFailed >= 1 ? st : null;
  }, { timeout: 60_000 });

  await waiter.clickLabel("Join call");
  await waiter.waitFor("waiter in call", () =>
    waiter.eval(`window.__awful.state.inCall || null`));

  await dialer.waitFor("roster reaches the dialer", async () => {
    const v = await dialer.voice();
    return v.roster.includes(waiterId) || null;
  }, { timeout: 30_000 });
  check.ok(true, "the peer already in the call learns the late joiner is in it");

  // The decisive one, and it asserts on COUNTERS rather than on a live link.
  // Two reasons. A link object on the DIALER proves nothing - it is created
  // before the dial is even attempted. And a link on the late joiner is not
  // reliably observable here: headless-to-headless ICE never completes, so the
  // RTCPeerConnection fails within a second and the (correctly backed off)
  // rebuild means it exists for about a second per redial. The counters are
  // monotonic, so polling cannot miss them - and they say something stronger
  // than "an object exists": an offer physically crossed the wire to a peer
  // that joined the call after us, which is precisely what never used to
  // happen. Before the fix both of these stay at zero forever.
  const seen = await waiter.waitFor("late joiner received the dial", async () => {
    const v = await waiter.voice();
    return v.stats.inboundStreams >= 1 && v.stats.offersIn >= 1 ? v.stats : null;
  }, { timeout: 60_000 });
  check.ok(true,
    `the late joiner was dialled and offered to (streams=${seen.inboundStreams}, offers=${seen.offersIn})`);

  // Leaving must clear the roster on the other side, or the reconcile keeps
  // dialling a peer who is not there.
  await waiter.clickLabel("Leave call");
  await waiter.waitFor("waiter left", () =>
    waiter.eval(`window.__awful.state.inCall === false || null`));
  await dialer.waitFor("roster shrinks", async () => {
    const v = await dialer.voice();
    return !v.roster.includes(waiterId) && !(waiterId in v.links) ? true : null;
  }, { timeout: 45_000 });
  check.ok(true, "a peer who leaves the call drops off the roster and its link");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
