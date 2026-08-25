/**
 * The belt-and-braces chat fallback: when the sender's gossipsub publish is
 * LOST (dead mesh, half-dead upgraded connection - injected here by dropping
 * outbound "text"/"plugin_update" frames), the direct one-message SyncBatch
 * copy must still deliver the message to room members promptly.
 *
 * Dev server only: fault injection is stripped from production builds.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("direct fallback delivers when gossip drops frames");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const domHas = (p, needle) => p.eval(
  `document.body.textContent.includes(${JSON.stringify(needle)}) || null`);

const timedSend = async (from, to, text, timeout = 20000) => {
  const t0 = Date.now();
  await from.eval(`window.__awful.sendMessage(${JSON.stringify(text)})`);
  const ok = await to.waitFor(`deliver ${text}`, () => domHas(to, text),
    { timeout, interval: 250 }).then(() => true).catch(() => false);
  return { ok, ms: Date.now() - t0 };
};

try {
  const room = await alice.createRoom("Fallback");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  const pre = await timedSend(alice, bob, "with-gossip-1");
  check.ok(pre.ok && pre.ms < 5000, `baseline delivery (${pre.ms}ms)`, pre);

  // Kill Alice's outbound chat GOSSIP: "text" frames are dropped wherever they
  // go out, but the fallback wraps chat in a "sync_batch" frame, which passes.
  await alice.eval(`window.__faults.set({ drop: ["text", "plugin_update"] })`);

  const r1 = await timedSend(alice, bob, "gossip-dropped-1");
  console.log("gossip-dropped-1:", JSON.stringify(r1),
    "faults:", await alice.json(`JSON.stringify(window.__faults.stats())`));
  check.ok(r1.ok && r1.ms < 5000,
    `message arrives via direct fallback with gossip dead (${r1.ms}ms)`, r1);

  const r2 = await timedSend(alice, bob, "gossip-dropped-2");
  check.ok(r2.ok && r2.ms < 5000,
    `and again (${r2.ms}ms)`, r2);

  // A poll vote with gossip dead: create the poll while gossip still works
  // on Bob's side, vote from Alice with her gossip dead.
  await alice.eval(`window.__faults.clear()`);
  await alice.say("/poll fallback-poll? yes,no");
  await bob.waitFor("poll on bob", () => domHas(bob, "fallback-poll"), { timeout: 20000 });
  await alice.eval(`window.__faults.set({ drop: ["text", "plugin_update"] })`);
  await alice.eval(`(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /Vote/i.test(b.textContent));
    btns[0].click(); return btns.length;
  })()`);
  const voteSeen = await bob.waitFor("alice's vote on bob", () => bob.eval(
    `document.body.textContent.includes('1 vote') || null`), { timeout: 15000 })
    .then(() => true).catch(() => false);
  check.ok(voteSeen, "vote arrives via direct fallback with gossip dead",
    { faults: await alice.json(`JSON.stringify(window.__faults.stats())`) });

  // Dropped-frame counter must actually have bitten, or this test proved nothing.
  const stats = await alice.json(`JSON.stringify(window.__faults.stats())`);
  check.ok(stats.droppedFrames >= 3, "fault injection actually dropped gossip frames", stats);

  await alice.eval(`window.__faults.clear()`);
  check.finish();
} finally {
  await closeAll([alice, bob]);
}
