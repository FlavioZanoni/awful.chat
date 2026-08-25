/**
 * Relay-restart resilience: peers connected through a relay that RESTARTS
 * must regain live gossip delivery after reconnecting. Reproduces "messages
 * take forever / never arrive since the redeploys, refresh fixes it".
 *
 * Needs: local relay in docker (awful2-relay-1) + app on AWFUL_URL.
 */
import { execSync } from "node:child_process";
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("gossip survives a relay restart");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const domHas = (p, needle) => p.eval(
  `document.body.textContent.includes(${JSON.stringify(needle)}) || null`);

const timedSend = async (from, to, text, timeout = 45000) => {
  const t0 = Date.now();
  await from.eval(`window.__awful.sendMessage(${JSON.stringify(text)})`);
  const ok = await to.waitFor(`deliver ${text}`, () => domHas(to, text),
    { timeout, interval: 250 }).then(() => true).catch(() => false);
  return { ok, ms: Date.now() - t0 };
};

try {
  const room = await alice.createRoom("Bounce");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  const before = await timedSend(alice, bob, "pre-bounce-1");
  check.ok(before.ok && before.ms < 5000,
    `baseline delivery works (${before.ms}ms)`, before);

  console.log("restarting relay container...");
  execSync("docker restart awful2-relay-1", { stdio: "inherit" });

  // Wait for both apps to report the relay connection is back.
  const reconnected = (p) => p.eval(
    `/Relay connected/i.test(document.body.textContent) ? true : null`);
  await alice.waitFor("alice reconnected", () => reconnected(alice), { timeout: 120000, interval: 1000 });
  await bob.waitFor("bob reconnected", () => reconnected(bob), { timeout: 120000, interval: 1000 });
  check.ok(true, "both peers report relay reconnected");

  // Give the mesh a moment to (supposedly) re-form, then measure delivery.
  const r1 = await timedSend(alice, bob, "post-bounce-1", 45000);
  console.log("post-bounce-1:", JSON.stringify(r1));
  const r2 = await timedSend(bob, alice, "post-bounce-2", 45000);
  console.log("post-bounce-2:", JSON.stringify(r2));
  const r3 = await timedSend(alice, bob, "post-bounce-3", 45000);
  console.log("post-bounce-3:", JSON.stringify(r3));

  check.ok(r1.ok, `A->B delivers after relay restart (${r1.ms}ms)`, r1);
  check.ok(r2.ok, `B->A delivers after relay restart (${r2.ms}ms)`, r2);
  check.ok(r3.ok && r3.ms < 5000, `delivery back to fast (${r3.ms}ms)`, r3);

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
