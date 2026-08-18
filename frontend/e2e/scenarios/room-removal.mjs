/**
 * Removing a room must tear EVERYTHING down: history, watermarks, the topic
 * subscription, and a call held in it - even while traffic keeps arriving.
 * Before this, removal deleted only the room row and the unread counter:
 * messages and attachments stayed in IndexedDB forever, the transport stayed
 * subscribed so peers quietly re-stored history for a room that no longer
 * existed, and a call in the removed room just kept going.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForMesh } from "../assert.mjs";

const check = new Check("room removal tears everything down");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const storedFor = (p, code) => p.json(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('awful-chat');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const get = (store) => new Promise((r) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => r(q.result);
  });
  const [rooms, msgs, wms] = await Promise.all([get('rooms'), get('messages'), get('watermarks')]);
  return JSON.stringify({
    room: rooms.some((r) => r.roomCode === ${JSON.stringify(code)}),
    messages: msgs.filter((m) => m.roomCode === ${JSON.stringify(code)}).length,
    watermarks: wms.filter((w) => w.roomCode === ${JSON.stringify(code)}).length,
  });
})()`);
const topics = (p) => p.json(`JSON.stringify(window.__awful.node()?.services.pubsub.getTopics() ?? [])`);

try {
  const room = await alice.createRoom("Doomed");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await alice.say("from alice");
  await bob.say("from bob");
  await alice.waitFor("history stored", async () => {
    const s = await storedFor(alice, room);
    return s.messages >= 2 ? s : null;
  });
  check.ok((await topics(alice)).includes(`app:room:${room}`), "subscribed before removal");

  // Fake being in a call in this room; removal must hang it up.
  await alice.eval(`(() => {
    const s = window.__awful.state;
    s.inCall = true; s.callRoomCode = s.roomCode;
    return true;
  })()`);

  // Remove through the real UI: right-click the sidebar row, click Remove.
  await alice.waitFor("context menu", async () => {
    await alice.eval(`(() => {
      const row = [...document.querySelectorAll('aside button')]
        .find((b) => b.innerText.includes(${JSON.stringify(room)}) || b.innerText.includes('Doomed'));
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
      return true;
    })()`);
    return alice.eval(`[...document.querySelectorAll('button')].some((b) => /Remove room/.test(b.textContent))`);
  });
  // Destructive actions arm on the first click and fire on the second.
  await alice.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Remove room/.test(x.textContent));
    b.click(); return true;
  })()`);
  await alice.waitFor("confirm step armed", () =>
    alice.eval(`[...document.querySelectorAll('button')].some((b) => /Click again to confirm/.test(b.textContent))`));
  await alice.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Click again to confirm/.test(x.textContent));
    b.click(); return true;
  })()`);

  const after = await alice.waitFor("room gone from storage", async () => {
    const s = await storedFor(alice, room);
    return !s.room && s.messages === 0 ? s : null;
  });
  check.equal(after, { room: false, messages: 0, watermarks: 0 }, "row, history and watermarks all deleted");
  check.ok(!(await topics(alice)).includes(`app:room:${room}`), "topic unsubscribed");
  check.ok(!(await alice.json(`JSON.stringify(window.__awful.state.inCall)`)), "call in the removed room was hung up");

  // Bob keeps talking into the room; nothing may come back from the dead.
  await bob.say("into the void 1");
  await sleep(4000);
  await bob.say("into the void 2");
  await sleep(16000); // spans a full repair-tick + digest window
  const resurrect = await storedFor(alice, room);
  check.equal(resurrect, { room: false, messages: 0, watermarks: 0 }, "no resurrection from incoming traffic");
  check.ok(!(await topics(alice)).includes(`app:room:${room}`), "still unsubscribed after traffic");

  // Bob's copy is untouched: removal is local.
  const bobs = await storedFor(bob, room);
  check.ok(bobs.room && bobs.messages >= 2, "the other peer keeps their copy", bobs);
} finally {
  await closeAll([alice, bob]);
}

check.finish();
