/**
 * Two conversation switches in quick succession must settle on the SECOND
 * one, with only its history on screen. Before the run tokens, the loser of
 * the race could write the winner's header or inject its messages.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("rapid room switching cannot cross wires");
const [alice] = await bootPeers(["Alice"], { ports: [9307] });

const clickRoomRow = (name) => alice.eval(`(() => {
  const row = [...document.querySelectorAll('aside button')]
    .find((b) => b.innerText.includes(${JSON.stringify(name)}));
  if (!row) return false;
  row.click();
  return true;
})()`);

try {
  const roomA = await alice.createRoom("Alpha");
  await alice.say("alpha message");
  const roomB = await alice.createRoom("Beta");
  await alice.say("beta message");

  for (const [first, second, secondCode, secondMsg, wrongMsg] of [
    ["Alpha", "Beta", roomB, "beta message", "alpha message"],
    ["Beta", "Alpha", roomA, "alpha message", "beta message"],
  ]) {
    // Fire both switches in the same tick: the first open is still awaiting
    // its history read when the second claims the token.
    await alice.waitFor(`double-switch ${first}->${second}`, async () => {
      await clickRoomRow(first);
      await clickRoomRow(second);
      return alice.eval(`window.__awful.state.roomCode === ${JSON.stringify(secondCode)} || null`);
    });
    const settled = await alice.waitFor(`view settled on ${second}`, () =>
      alice.json(`JSON.stringify({
        roomCode: window.__awful.state.roomCode,
        contents: window.__awful.state.messages.map((m) => m.content),
        foreign: window.__awful.state.messages.filter(
          (m) => m.roomCode !== ${JSON.stringify(secondCode)}).length,
      })`));
    check.equal(settled.roomCode, secondCode, `landed in ${second}`);
    check.ok(
      settled.contents.includes(secondMsg) && settled.foreign === 0,
      `only ${second}'s history on screen`,
      settled
    );
    check.ok(!settled.contents.includes(wrongMsg),
      `${first}'s messages did not leak into ${second}`);
  }

  // Storage integrity: every message still filed under its own room.
  const stored = await alice.json(`(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('awful-chat'); r.onsuccess = () => res(r.result);
    });
    const msgs = await new Promise((r) => {
      const q = db.transaction('messages').objectStore('messages').getAll();
      q.onsuccess = () => r(q.result);
    });
    return JSON.stringify(msgs.map((m) => ({ room: m.roomCode, content: m.content })));
  })()`);
  check.ok(
    stored.some((m) => m.room === roomA && m.content === "alpha message") &&
      stored.some((m) => m.room === roomB && m.content === "beta message") &&
      stored.length === 2,
    "stored rows kept their own room codes",
    stored
  );

  check.finish();
} finally {
  await closeAll([alice]);
}
