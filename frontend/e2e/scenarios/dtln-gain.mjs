// Assert the worklet's hidden 3x default is pinned to 1 at init, so the only
// output boost is the visible OUTPUT_COMPENSATION. Captures every message
// posted to the worklet port.
import { Peer } from "../driver.mjs";
const p = new Peer(9307, "A");
await p.bidi.open();
await p.bidi.send("script.addPreloadScript", { functionDeclaration: `() => {
  window.__workletMsgs = [];
  const orig = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (msg, ...rest) {
    try {
      if (msg && (typeof msg.output_gain === "number" || typeof msg.noise_gate === "number")) {
        window.__workletMsgs.push(JSON.parse(JSON.stringify(msg)));
      }
    } catch {}
    return orig.call(this, msg, ...rest);
  };
}`});
await p.go("/app");
const msgs = await p.waitFor("worklet init message", async () => {
  const m = await p.json(`JSON.stringify(window.__workletMsgs)`);
  return m.length ? m : null;
});
console.log("worklet messages:", JSON.stringify(msgs));
const pinned = msgs.some((m) => m.output_gain === 1);
console.log(pinned ? "PASS output_gain pinned to 1 at init" : "FAIL worklet default 3 still active");
process.exitCode = pinned ? 0 : 1;
await p.close();
