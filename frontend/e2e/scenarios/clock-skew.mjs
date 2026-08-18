/**
 * A peer whose clock runs hours behind must still produce messages that land
 * ABOVE the seen watermark and at the END of the conversation. Before the
 * hybrid DM lamport, a behind-clock reply filed below the watermark: no
 * unread badge, and hidden mid-history after a reload.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("clock-skewed peer still lands unread and last");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const dmState = (p, code) => p.json(`(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('awful-chat'); r.onsuccess = () => res(r.result);
  });
  const get = (store) => new Promise((r) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => r(q.result);
  });
  const [rooms, msgs] = await Promise.all([get('rooms'), get('messages')]);
  const room = rooms.find((x) => x.roomCode === ${JSON.stringify(code)});
  const inRoom = msgs.filter((m) => m.roomCode === ${JSON.stringify(code)})
    .sort((a, b) => a.lamport - b.lamport);
  return JSON.stringify({
    lastSeen: room?.lastSeenLamport ?? null,
    order: inRoom.map((m) => ({ content: m.content, lamport: m.lamport })),
  });
})()`);

try {
  const room = await alice.createRoom("Skew");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.eval(`(async () => {
    const dids = [...window.__awful.peerIdToDid.values()];
    const m = await import('/src/lib/transport/dm.svelte.ts');
    await m.openDmConversation(dids[0]);
    return true;
  })()`);
  const dmCode = await alice.waitFor("dm open", () =>
    alice.eval(`(window.__awful.state.chatMode === 'dm' && window.__awful.state.roomCode) || null`));
  await alice.say("on time");
  await bob.waitFor("dm delivered", async () => {
    const s = await dmState(bob, dmCode);
    return s.order.some((m) => m.content === "on time") ? s : null;
  });

  // Alice walks away so the reply must earn a real unread mark.
  await alice.openRoom(room);
  const before = await dmState(alice, dmCode);

  // Bob's clock jumps two hours into the past, then he replies.
  await bob.eval(`(async () => {
    const m = await import('/src/lib/transport/dm.svelte.ts');
    const dids = [...window.__awful.peerIdToDid.values()];
    await m.openDmConversation(dids[0]);
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() - 2 * 60 * 60 * 1000;
    await m.sendDirectMessage("late clock reply");
    Date.now = realNow;
    return true;
  })()`);

  const after = await alice.waitFor("skewed reply arrived", async () => {
    const s = await dmState(alice, dmCode);
    return s.order.some((m) => m.content === "late clock reply") ? s : null;
  });
  const reply = after.order.find((m) => m.content === "late clock reply");
  const prevMax = Math.max(...before.order.map((m) => m.lamport));
  check.ok(reply.lamport > prevMax,
    `reply lamport ${reply.lamport} sits above the room max ${prevMax}`);
  check.ok(reply.lamport > after.lastSeen,
    `reply is above the seen watermark ${after.lastSeen} (counts as unread)`);
  check.equal(after.order[after.order.length - 1].content, "late clock reply",
    "reply sorts last despite the backdated clock");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
