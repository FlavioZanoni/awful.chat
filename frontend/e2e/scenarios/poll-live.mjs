/**
 * Poll + live-view regression: with a plugin card mounted, votes and
 * subsequent text messages must still reach the live view of BOTH peers
 * without a reload. A throwing effect in the card path can kill the whole
 * app's reactive tree, freezing every surface at once.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("poll votes and follow-up messages stay live");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const hookErrors = (p) => p.eval(`(() => {
  if (window.__errlog) return true;
  window.__errlog = [];
  window.addEventListener('error', (e) => window.__errlog.push('uncaught: ' + (e.error?.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errlog.push('rej: ' + (e.reason?.stack || String(e.reason))));
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errlog.push('console.error: ' + a.map(x => (x && x.message) ? (x.name + ': ' + x.message + String(x.stack||'').slice(0,600)) : String(x)).join(' ')); oe(...a); };
  return true;
})()`);
const errs = (p) => p.json(`JSON.stringify(window.__errlog.slice(0, 20))`);

try {
  await hookErrors(alice);
  await hookErrors(bob);

  const room = await alice.createRoom("PollLive");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  // Alice creates a poll via the slash command through the real composer.
  await alice.say("/poll pick-one? alpha,beta");

  await alice.waitFor("poll card on alice", () => alice.eval(
    `document.body.textContent.includes('pick-one') || null`), { timeout: 20000 });
  await bob.waitFor("poll card on bob", () => bob.eval(
    `document.body.textContent.includes('pick-one') || null`), { timeout: 30000 });
  check.ok(true, "poll card rendered on both peers", { a: await errs(alice), b: await errs(bob) });

  // Bob votes for "alpha" by clicking the first Vote button.
  await bob.eval(`(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /Vote/i.test(b.textContent));
    if (!btns.length) return false;
    btns[0].click();
    return true;
  })()`);

  // Bob must see his own vote fold live (checkmark / 100%).
  const bobSaw = await bob.waitFor("own vote visible on bob", () => bob.eval(
    `document.body.textContent.includes('1 vote') || null`), { timeout: 15000 })
    .then(() => true).catch(() => false);
  check.ok(bobSaw, "bob sees his own vote without reload", { b: await errs(bob) });

  // Alice must see bob's vote live too.
  const aliceSaw = await alice.waitFor("bob's vote visible on alice", () => alice.eval(
    `document.body.textContent.includes('1 vote') || null`), { timeout: 20000 })
    .then(() => true).catch(() => false);
  check.ok(aliceSaw, "alice sees bob's vote without reload", { a: await errs(alice) });

  // After all the plugin traffic, a plain text message must still go live.
  await alice.eval(`window.__awful.sendMessage('after-poll-text')`);
  const bobText = await bob.waitFor("text after poll on bob", () => bob.eval(
    `document.body.textContent.includes('after-poll-text') || null`), { timeout: 20000 })
    .then(() => true).catch(() => false);
  check.ok(bobText, "text message after poll reaches bob's DOM live",
    { b: await errs(bob) });

  const aliceText = await alice.eval(
    `document.body.textContent.includes('after-poll-text')`);
  check.ok(aliceText === true, "sender still sees own text after poll",
    { a: await errs(alice) });

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
