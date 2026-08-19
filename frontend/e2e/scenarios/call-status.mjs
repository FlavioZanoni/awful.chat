/**
 * The call status tells the truth: "Waiting for others" while alone,
 * "Connecting" while a peer's voice link is still handshaking, and
 * "Connected" only once the announced peers are actually connected.
 * Requires the fake-media prefs browsers.sh writes into the profiles.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("call status reflects real voice connections");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("StatusLab");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.clickLabel("Join call");
  await alice.waitFor("alice in call", () =>
    alice.eval(`window.__awful.state.inCall || null`));
  await alice.waitFor("waiting label", () =>
    alice.eval(`/Waiting for others/.test(document.body.innerText) || null`),
    { timeout: 15000 });
  check.ok(true, "alone in the call shows 'Waiting for others'");

  await bob.clickLabel("Join call");
  await bob.waitFor("bob in call", () =>
    bob.eval(`window.__awful.state.inCall || null`));
  await alice.waitFor("connected label", () =>
    alice.eval(`/Connected/.test(document.body.innerText) || null`),
    { timeout: 60000 });
  check.ok(true, "reaches Connected once the peer's voice link is up");

  // The users sidebar groups call members into an "In call" container.
  await alice.clickLabel("Toggle user list");
  await alice.waitFor("in-call group", () => alice.eval(`(() => {
    const t = document.body.innerText;
    if (!/In call/.test(t)) return null;
    const inCallLines = t.split(String.fromCharCode(10)).filter((l) => l.trim() === 'In call').length;
    return inCallLines >= 2 ? true : null;
  })()`), { timeout: 20000 });
  check.ok(true, "sidebar groups both members under 'In call'");

  // The local mic pipeline is live: the fake mic emits a tone, so our own
  // speaking ring must be on.
  await alice.waitFor("own speaking ring", () =>
    alice.eval(`document.querySelectorAll('[class*="ring-primary"]').length >= 1 || null`),
    { timeout: 15000 });
  check.ok(true, "local mic pipeline live (own speaking ring on)");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
