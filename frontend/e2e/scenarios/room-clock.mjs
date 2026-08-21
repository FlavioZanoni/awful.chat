/**
 * A busy room must not skew the ordering of a quiet one.
 *
 * The lamport clock used to be a single counter shared by every non-DM room
 * and absorbed from all of them, so somebody active in a loud room carried a
 * large counter into a quiet one. Their next message there outranked messages
 * that were genuinely older, and two people posting at the same moment were
 * ordered by which of them had been busier elsewhere rather than by what
 * happened first. Only the DM hybrid clock had a scenario; the room path had
 * none.
 *
 * Alice runs her clock up in room Loud, then Bob speaks first in room Quiet
 * and Alice answers. Bob's message must sort first on both sides.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForConvergence, waitForMesh } from "../assert.mjs";

const check = new Check("a busy room does not skew a quiet one");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const loud = await alice.createRoom("Loud");
  await bob.joinRoom(loud);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  // Run Alice's clock up where Bob's is not.
  for (let i = 0; i < 12; i++) await alice.say(`loud ${i}`);
  await bob.waitFor("loud delivered", async () =>
    (await bob.stored(loud)).includes("loud 11") || null, { timeout: 45_000 });

  const quiet = await bob.createRoom("Quiet");
  await alice.joinRoom(quiet);
  await waitForMesh([alice, bob], 1);

  // Bob speaks first, Alice answers. The send order is unambiguous.
  await bob.say("bob first");
  await alice.waitFor("alice saw it", async () =>
    (await alice.stored(quiet)).includes("bob first") || null, { timeout: 45_000 });
  await alice.say("alice second");

  const agreed = await waitForConvergence([alice, bob], quiet);
  check.equal(agreed, ["bob first", "alice second"],
    "the quiet room orders by what happened, not by who was busier");

  // And the lamports stay small - proof the counter is the room's own rather
  // than one inherited from Loud.
  const lamports = await alice.json(`JSON.stringify(
    window.__awful.state.messages.map((m) => m.lamport)
  )`);
  check.ok(
    lamports.every((l) => l < 12),
    `the quiet room's clock started from its own history (${lamports.join(",")})`,
    lamports
  );

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
