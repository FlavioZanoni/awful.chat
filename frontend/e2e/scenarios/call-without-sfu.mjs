/**
 * A call survives the media server being down.
 *
 * Voice is peer-to-peer; only camera and screen share go through the SFU. But
 * joinCall awaited _video.join() unguarded, so an SFU outage - or a VPS whose
 * DNS had moved out from under it - threw before `inCall` was ever set and
 * rolled the whole join back. Nobody could talk to anybody, over a server the
 * conversation never needed.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("a call joins and works while the SFU is down");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("NoSfu");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.faults({ blockSfu: true });
  await bob.faults({ blockSfu: true });

  // Same ordering trick as call-late-join: the higher id is the one that
  // dials, so it has to be the one already sitting in the call.
  const ids = { alice: await alice.selfId(), bob: await bob.selfId() };
  const [dialer, waiter] = ids.alice > ids.bob ? [alice, bob] : [bob, alice];

  await dialer.clickLabel("Join call");
  await dialer.waitFor("dialer in call", () =>
    dialer.eval(`window.__awful.state.inCall || null`), { timeout: 30_000 });
  check.ok(true, "the call joins with no SFU to join");

  check.ok(
    (await dialer.videoConnected()) === false,
    "the SFU really is unreachable (not a vacuous pass)"
  );

  const err = await dialer.eval(`window.__awful.state.error`);
  check.ok(
    typeof err === "string" && /voice still works/i.test(err),
    "the user is told video is out and voice is not",
    { error: err }
  );

  await waiter.clickLabel("Join call");
  await waiter.waitFor("waiter in call", () =>
    waiter.eval(`window.__awful.state.inCall || null`), { timeout: 30_000 });

  // The whole point: voice signalling still crosses without the SFU. Counters
  // rather than a live link, for the reason spelled out in call-late-join.
  await waiter.waitFor("voice signalling crossed", async () => {
    const v = await waiter.voice();
    return v.stats.inboundStreams >= 1 && v.stats.offersIn >= 1 ? true : null;
  }, { timeout: 60_000 });
  check.ok(true, "peers still negotiate voice with the SFU down");

  // And the SFU is picked up again by itself once it comes back.
  await dialer.clearFaults();
  await waiter.clearFaults();
  await dialer.waitFor("sfu healed", async () =>
    (await dialer.videoConnected()) || null, { timeout: 90_000 });
  check.ok(true, "the SFU session heals on its own once it is reachable");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
