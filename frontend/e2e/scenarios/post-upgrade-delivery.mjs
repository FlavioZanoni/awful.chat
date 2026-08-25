/**
 * Gossip after the WebRTC upgrade: peers start relay-circuit, then upgrade to
 * a direct WebRTC connection. Chat rides gossipsub - if the mesh does not
 * survive the connection swap, messages stall while direct streams (profiles,
 * digests) keep working. That is exactly the reported symptom.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("gossip delivery survives the webrtc upgrade");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const domHas = (p, needle) => p.eval(
  `document.body.textContent.includes(${JSON.stringify(needle)}) || null`);

const timedSend = async (from, to, text, timeout = 30000) => {
  const t0 = Date.now();
  await from.eval(`window.__awful.sendMessage(${JSON.stringify(text)})`);
  const ok = await to.waitFor(`deliver ${text}`, () => domHas(to, text),
    { timeout, interval: 250 }).then(() => true).catch(() => false);
  return { ok, ms: Date.now() - t0 };
};

const relayedCount = (p) => p.eval(`window.__awful.relayed().length`);
const peerCount = (p) => p.eval(`window.__awful.state.peers.length`);

try {
  const room = await alice.createRoom("Upgrade");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  const pre = await timedSend(alice, bob, "pre-upgrade-1");
  check.ok(pre.ok && pre.ms < 5000, `pre-upgrade delivery (${pre.ms}ms)`, pre);
  console.log("relayed before:", await relayedCount(alice), await relayedCount(bob));

  // Wait for the relay-circuit connection to be upgraded away: relayed() empty
  // while the peer is still connected.
  const upgraded = async (p) =>
    (await peerCount(p)) >= 1 && (await relayedCount(p)) === 0 ? true : null;
  const aliceUp = await alice.waitFor("alice upgraded", () => upgraded(alice),
    { timeout: 120000, interval: 1000 }).then(() => true).catch(() => false);
  const bobUp = await bob.waitFor("bob upgraded", () => upgraded(bob),
    { timeout: 120000, interval: 1000 }).then(() => true).catch(() => false);
  console.log("upgraded:", aliceUp, bobUp,
    "relayed now:", await relayedCount(alice), await relayedCount(bob));
  check.ok(aliceUp && bobUp, "both peers upgraded to a direct connection");

  // Now the real question: does chat still arrive?
  const r1 = await timedSend(alice, bob, "post-upgrade-1", 30000);
  console.log("post-upgrade-1:", JSON.stringify(r1));
  const r2 = await timedSend(bob, alice, "post-upgrade-2", 30000);
  console.log("post-upgrade-2:", JSON.stringify(r2));
  const r3 = await timedSend(alice, bob, "post-upgrade-3", 30000);
  console.log("post-upgrade-3:", JSON.stringify(r3));

  check.ok(r1.ok && r1.ms < 5000, `A->B after upgrade (${r1.ms}ms)`, r1);
  check.ok(r2.ok && r2.ms < 5000, `B->A after upgrade (${r2.ms}ms)`, r2);
  check.ok(r3.ok && r3.ms < 5000, `A->B again (${r3.ms}ms)`, r3);

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
