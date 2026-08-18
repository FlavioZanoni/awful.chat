/**
 * Assertions for a distributed app.
 *
 * The useful property is convergence: after the faults are cleared, everyone
 * ends up holding the same thing. It survives refactoring, unlike asserting
 * that a particular event fired in a particular order, and it is the property
 * a user actually cares about.
 */

export class Check {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.passes = 0;
  }

  ok(condition, label, detail) {
    if (condition) {
      this.passes++;
      console.log(`  PASS  ${label}`);
    } else {
      this.failures.push(label);
      console.log(`  FAIL  ${label}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
    }
    return !!condition;
  }

  equal(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    return this.ok(a === b, label, a === b ? undefined : { actual, expected });
  }

  finish() {
    const failed = this.failures.length;
    console.log(
      `\n${failed ? "FAILED" : "OK"}  ${this.name}  (${this.passes} passed, ${failed} failed)`
    );
    if (failed) process.exitCode = 1;
    return failed === 0;
  }
}

/**
 * Wait until every peer's stored history for a room is identical.
 * Returns the agreed contents, or throws with each peer's view.
 */
export async function waitForConvergence(peers, roomCode, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  let views = [];
  while (Date.now() < deadline) {
    views = await Promise.all(peers.map((p) => p.stored(roomCode)));
    const first = JSON.stringify(views[0]);
    if (views.every((v) => JSON.stringify(v) === first)) return views[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "did not converge:\n" +
      peers.map((p, i) => `  ${p.name}: ${JSON.stringify(views[i])}`).join("\n")
  );
}

/**
 * Wait until every peer has identified at least `min` others.
 *
 * Being connected is not the same as knowing who you are connected to: the
 * profile exchange lands a moment later, and asserting on it immediately after
 * the connection reports a failure that is not real.
 */
export async function waitForBinding(peers, min = 1, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  let states = [];
  while (Date.now() < deadline) {
    states = await Promise.all(peers.map((p) => p.state()));
    if (states.every((s) => s.bound >= min)) return states;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "peers never identified each other:\n" +
      peers.map((p, i) => `  ${p.name}: peers=${states[i]?.peers} bound=${states[i]?.bound}`).join("\n")
  );
}

/** Wait until every peer sees the expected number of connected peers. */
export async function waitForMesh(peers, expected, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  let states = [];
  while (Date.now() < deadline) {
    states = await Promise.all(peers.map((p) => p.state()));
    if (states.every((s) => s.peers >= expected)) return states;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "mesh never formed:\n" +
      peers.map((p, i) => `  ${p.name}: peers=${states[i]?.peers} bound=${states[i]?.bound}`).join("\n")
  );
}
