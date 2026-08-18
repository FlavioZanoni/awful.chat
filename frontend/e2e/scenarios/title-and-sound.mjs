/**
 * Incoming messages: the tab title carries the unread count, and a soft sound
 * plays - but not while you are reading that conversation with focus, and not
 * with the toggle off. The focus axis is untestable headless (the window
 * always reports focused), so it is covered by unit tests on the pure rule.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForMesh } from "../assert.mjs";

const check = new Check("unread title and message sounds");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const oscs = () => alice.json(`window.__oscs ?? 0`);
const title = () => alice.eval(`document.title`);

try {
  // Count oscillators: every sound is synthesized, so this counts sounds.
  await alice.eval(`(() => {
    if (window.__oscWrapped) return true;
    window.__oscWrapped = true;
    window.__oscs = 0;
    window.__oscFreqs = [];
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.__oscs++;
      const o = orig.call(this);
      setTimeout(() => window.__oscFreqs.push(Math.round(o.frequency.value)), 0);
      return o;
    };
    return true;
  })()`);

  const room = await alice.createRoom("Sounds");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);

  // Case 1: Alice is READING the room (focused headless window) - silent,
  // and the title stays clean because the message is seen immediately.
  const before1 = await oscs();
  await bob.say("seen live");
  await alice.waitFor("message visible", () =>
    alice.eval(`window.__awful.state.messages.some(m => m.content === 'seen live')`));
  await sleep(1500);
  check.equal((await oscs()) - before1, 0, "silent while reading the conversation");
  check.equal(await title(), "Awful.chat", "title clean while reading");

  // Case 2: Alice looks at another screen - sound plays, title counts.
  await alice.eval(`(() => {
    history.pushState({}, '', '/app');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return true;
  })()`);
  await sleep(1500);
  const before2 = await oscs();
  await bob.say("unseen one");
  const t = await alice.waitFor("title shows unread", async () => {
    const v = await title();
    return /^\(\d+\) Awful\.chat$/.test(v) ? v : null;
  });
  check.ok(true, `title became "${t}"`);
  check.ok((await oscs()) - before2 >= 2, "sound played for the unseen message");

  // Case 3: toggle off THROUGH THE UI - a dynamic import() of the module
  // reaches a second instance after HMR (vite versions invalidated URLs), so
  // the toggle must be the real switch. Settings -> App.
  await alice.waitFor("settings open", async () => {
    await alice.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.querySelector('svg.lucide-settings'));
      b?.click(); return true;
    })()`);
    return alice.eval(`[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'App')`);
  });
  await alice.waitFor("sounds toggled off", async () => {
    await alice.eval(`(() => {
      const tab = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'App');
      tab?.click(); return true;
    })()`);
    await alice.eval(`(() => {
      const label = [...document.querySelectorAll('span')].find((el) => el.textContent.trim() === 'Message sounds');
      const row = label?.closest('div.flex.items-center');
      const sw = row?.querySelector('[role=switch]');
      if (sw && sw.getAttribute('aria-checked') === 'true') sw.click();
      return true;
    })()`);
    return alice.eval(`(() => {
      const label = [...document.querySelectorAll('span')].find((el) => el.textContent.trim() === 'Message sounds');
      const sw = label?.closest('div.flex.items-center')?.querySelector('[role=switch]');
      return sw?.getAttribute('aria-checked') === 'false';
    })()`);
  });
  await alice.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(800);
  const before3 = await oscs();
  await bob.say("unseen two");
  await alice.waitFor("second unread", async () => /^\(/.test(await title()));
  await sleep(2500);
  const played = await alice.json(`JSON.stringify(window.__oscFreqs.slice(-6))`);
  console.log("    recent oscillator freqs:", played);
  check.equal((await oscs()) - before3, 0, "toggle off silences the sound");
  check.ok(
    await alice.eval(`localStorage.getItem('awful:message-sounds:v1') === '0'`),
    "toggle persisted"
  );

  // Reading the room clears the count from the title again.
  await alice.openRoom(room);
  const cleared = await alice.waitFor("title cleared", async () =>
    (await title()) === "Awful.chat" ? true : null);
  check.ok(cleared, "opening the room clears the title count");
} finally {
  await closeAll([alice, bob]);
}

check.finish();
