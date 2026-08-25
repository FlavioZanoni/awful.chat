/**
 * Live-view regression check: a message sent by Alice must appear in Bob's
 * LIVE view (window.__awful.state.messages) without a reload, not just in
 * IndexedDB. Reproduces "I need to refresh the page to see new messages".
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("live message reaches the view without reload");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const storedCount = (p, code, needle) => p.eval(`(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('awful-chat'); r.onsuccess = () => res(r.result);
  });
  const msgs = await new Promise((r) => {
    const q = db.transaction('messages').objectStore('messages').getAll();
    q.onsuccess = () => r(q.result);
  });
  return msgs.filter((m) => m.roomCode === ${JSON.stringify(code)}
    && m.content === ${JSON.stringify(needle)}).length;
})()`);

try {
  // Capture uncaught errors and console.error on Bob's page from the start.
  for (const p of [alice, bob]) {
    await p.eval(`(() => {
      if (window.__errlog) return true;
      window.__errlog = [];
      window.addEventListener('error', (e) => window.__errlog.push('uncaught: ' + (e.error?.stack || e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errlog.push('unhandledrejection: ' + (e.reason?.stack || String(e.reason))));
      const orig = console.error.bind(console);
      console.error = (...a) => { window.__errlog.push('console.error: ' + a.map(x => x?.stack || String(x)).join(' ')); orig(...a); };
      return true;
    })()`);
  }

  const room = await alice.createRoom("LiveView");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.eval(`window.__awful.sendMessage('live-check-1')`);

  // Storage must converge (this has always worked per the user's report).
  await bob.waitFor("stored on bob", async () =>
    (await storedCount(bob, room, 'live-check-1')) === 1 ? true : null,
    { timeout: 30000 });
  check.ok(true, "message reached bob's IndexedDB");

  // THE assertion the existing suite lacks: the live view, no reload.
  const inView = await bob.eval(
    `window.__awful.state.messages.some((m) => m.content === 'live-check-1')`);
  const errlog = await bob.json(`JSON.stringify(window.__errlog)`);
  check.ok(inView === true, "message is in bob's live view without reload",
    { inView, errlog });

  // State updating is not enough - the DOM must actually render it. A
  // throwing $effect can freeze the render tree while state keeps moving.
  await bob.waitFor("rendered in DOM", () => bob.eval(
    `document.body.textContent.includes('live-check-1') || null`),
    { timeout: 10000 }).catch(() => {});
  const inDom = await bob.eval(
    `document.body.textContent.includes('live-check-1')`);
  const errlog2 = await bob.json(`JSON.stringify(window.__errlog)`);
  check.ok(inDom === true, "message is in bob's DOM without reload",
    { inDom, errlog2 });

  // Belt-and-braces sends mean bob can receive the same message twice
  // (gossip + direct batch) - it must land in the view exactly once.
  const copies = await bob.eval(
    `window.__awful.state.messages.filter((m) => m.content === 'live-check-1').length`);
  check.ok(copies === 1, "duplicate delivery dedups to one view row", { copies });

  // Same for the echo on alice's own view (sender side).
  const aliceView = await alice.eval(
    `window.__awful.state.messages.some((m) => m.content === 'live-check-1')`);
  check.ok(aliceView === true, "sender sees own message live", { aliceView });

  // Bob replies; alice must see it live too (both directions).
  await bob.eval(`window.__awful.sendMessage('live-check-2')`);
  await alice.waitFor("stored on alice", async () =>
    (await storedCount(alice, room, 'live-check-2')) === 1 ? true : null,
    { timeout: 30000 });
  const aliceView2 = await alice.eval(
    `window.__awful.state.messages.some((m) => m.content === 'live-check-2')`);
  const aliceErrs = await alice.json(`JSON.stringify(window.__errlog)`);
  check.ok(aliceView2 === true, "reply is in alice's live view without reload",
    { aliceView2, aliceErrs });
  await alice.waitFor("reply rendered in DOM", () => alice.eval(
    `document.body.textContent.includes('live-check-2') || null`),
    { timeout: 10000 }).catch(() => {});
  const aliceDom = await alice.eval(
    `document.body.textContent.includes('live-check-2')`);
  check.ok(aliceDom === true, "reply is in alice's DOM without reload",
    { aliceDom });

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
