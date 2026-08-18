/**
 * Audio settings survive a reload, and merely OPENING the settings screen
 * must never rewrite them: the sliders used to mount at a hardcoded 100% and
 * snap to the saved value a beat later - "the slider flickered when I came
 * back" - and a change event landing in that window saved the default over
 * the user's value.
 */
import { Peer } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("audio prefs survive reloads and settings opens");
const p = new Peer(9307, "A");
await p.start();
await p.signUp("AudioTester");

const openAudio = async () => {
  await p.waitFor("settings open", async () => {
    await p.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.querySelector('svg.lucide-settings'));
      if (b) b.click(); return !!b;
    })()`);
    return p.eval(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Audio')`);
  });
  await p.waitFor("audio tab", async () => {
    await p.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Audio');
      if (b) b.click(); return !!b;
    })()`);
    return p.eval(`/Input gain/.test(document.body.innerText)`);
  });
};
// Collapse whitespace first: the value renders on its own line below the label.
const readGain = () =>
  p.eval(
    "(document.body.innerText.split(/\\s+/).join(' ').match(/Input gain (\\S+)/) || [])[1]"
  );
const prefs = () => p.eval(`localStorage.getItem('awful_audio_prefs')`);

await openAudio();
check.equal(await readGain(), "100%", "fresh install reads an exact 100%");

// Drag the gain down via keyboard - retried inside the wait, because a
// dispatch that lands before the slider is interactive is silently lost.
const shown = await p.waitFor("gain changed", async () => {
  const g = await readGain();
  if (g && g !== "100%") return g;
  await p.eval(`(() => {
    const s = [...document.querySelectorAll('[role=slider]')][0];
    if (!s) return false;
    s.focus();
    for (let i = 0; i < 4; i++) s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    return true;
  })()`);
  return null;
});
const saved = await prefs();
check.ok(saved?.includes("inputGain"), "change was persisted", saved);

// Reload; the slider must come back at the saved value with prefs untouched.
await p.go("/app");
await openAudio();
check.equal(await readGain(), shown, "reload restores the exact value");

// Open and close settings several times: the stored prefs must be byte-equal
// after every open - this is the flicker-clobber assertion.
for (let i = 0; i < 3; i++) {
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await p.go("/app");
  await openAudio();
}
check.equal(await prefs(), saved, "opening settings never rewrites the prefs");
check.equal(await readGain(), shown, "value still correct after repeated opens");

await p.close();
check.finish();
