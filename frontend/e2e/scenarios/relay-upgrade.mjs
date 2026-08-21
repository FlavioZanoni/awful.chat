/**
 * A connection that fell back to the relay's circuit gets promoted to a direct
 * one later.
 *
 * dialPeer tries /p2p-circuit/webrtc first and falls back to a plain circuit,
 * and that first dial routinely loses a race with the other side's relay
 * reservation (which can take 20s). Whoever lost stayed on the relay for the
 * rest of the session: every app frame through the relay, and a connection
 * that dies whenever the relay hiccups. Nothing ever retried the good address.
 *
 * The fault reproduces that race on demand instead of waiting to be unlucky.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForConvergence, waitForMesh } from "../assert.mjs";

const check = new Check("relayed peers are upgraded to direct connections");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  // Before they ever dial each other, so the very first dial takes the
  // fallback - exactly what the reservation race does.
  await alice.faults({ blockWebrtcDial: true });
  await bob.faults({ blockWebrtcDial: true });

  const room = await alice.createRoom("RelayLab");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  const bobId = await bob.selfId();
  await alice.waitFor("alice is relayed", async () =>
    (await alice.relayed()).includes(bobId) || null, { timeout: 45_000 });
  check.ok(true, "the blocked dial really did fall back to the relay");

  const before = await alice.transportStats();
  check.equal(before.relayUpgrades, 0, "no upgrade succeeded yet, as expected");

  // The regression is "nothing ever retried the good address", so the decisive
  // measurement is that attempts keep coming while the peer is stuck on the
  // relay. Success cannot be asserted here: two headless browsers on one host
  // do not hold a browser-to-browser WebRTC connection reliably (the same
  // limitation call-status.mjs runs into), so it would be a coin flip.
  await alice.waitFor("retries keep coming", async () =>
    (await alice.transportStats()).relayUpgradeAttempts >= 2 || null,
    { timeout: 90_000 });
  check.ok(true, "a relayed peer is retried instead of written off");

  // ...and bounded, or an unreachable peer would be dialled every tick for the
  // whole session.
  const during = await alice.transportStats();
  check.ok(
    during.relayUpgradeAttempts <= 8,
    `the retries back off rather than running every tick (${during.relayUpgradeAttempts} in ~90s)`,
    during
  );

  await alice.clearFaults();
  await bob.clearFaults();

  await alice.waitFor("no longer relayed", async () =>
    !(await alice.relayed()).includes(bobId) || null, { timeout: 60_000 });
  check.ok(true, "the peer ends up on a direct connection once one is possible");

  // The upgrade resets the outbound stream, so prove nothing was lost with it.
  await alice.say("after the upgrade");
  await bob.say("and back again");
  const converged = await waitForConvergence([alice, bob], room);
  check.ok(
    converged.includes("after the upgrade") && converged.includes("and back again"),
    "messaging still works after the stream moves to the new connection",
    converged
  );

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
