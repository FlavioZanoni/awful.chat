# Writing plugins

Plugins are folders in this directory, bundled with the app at build time and
served to every user of this instance. Think Minecraft mods: whoever runs the
instance decides what ships, everyone on it gets the same set, and adding one
is a folder plus a redeploy. There is no runtime installation and no
sandboxing, because a plugin runs with the same trust as the app itself.

## Anatomy

```
frontend/plugins/
  wheel/
    manifest.ts   loaded eagerly at boot: metadata only, no logic
    index.ts      lazy-loaded on first use: the actual plugin
    WheelCard.svelte
```

`manifest.ts` exports metadata only. It must stay import-light: every
manifest loads at boot, and heavy imports here defeat the lazy loading.

```ts
import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "wheel",            // ^[a-z0-9-]{2,32}$, must match the folder name
  name: "Wheel decide",
  description: "Spin a wheel to settle what to play.",
  icon: "🎡",             // an emoji, or "lucide:<kebab-name>" (e.g. "lucide:dices")
  author: "you",          // optional, shown in the plugins settings list
  license: "MIT",         // optional, shown next to the author
  apiVersion: 1,
  commands: [{ name: "wheel", usage: "/wheel option1, option2, ..." }],
};
```

`index.ts` is the plugin:

```ts
import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import WheelCard from "./WheelCard.svelte";

export default definePlugin({
  manifest,
  card: WheelCard,
  initialState: () => ({ spun: false, winner: null as number | null }),
  reduce(state, update, ctx) {
    // First spin wins; every later spin is a no-op.
    if (state.spun || update.data.action !== "spin") return state;
    return { spun: true, winner: pickWinner(update, ctx) };
  },
  commands: {
    wheel: async (args, host) => {
      const options = args.split(",").map((s) => s.trim()).filter(Boolean);
      if (options.length >= 2) await host.sendCard({ options });
    },
  },
});
```

## The contract

**Cards** are chat messages your component renders. They persist, sync to
peers who were offline, and survive reloads. Your card component receives
`{ card, cardState, host }`: the card message, your reduced state, and the
host API. The prop is `cardState`, never `state`: in Svelte 5 a binding
named `state` makes the compiler treat your own `$state(...)` runes as store
subscriptions to that prop, and the component crashes on mount.

**Updates** attach to a card. `host.sendUpdate(cardId, data)` persists and
replays; `{ ephemeral: true }` sends live-only (cursors, ticks) and is capped
at ~4 per second per sender. Your `reduce(state, update, ctx)` folds them:
history first in a deterministic order, then live. Keep it pure, keep it a
function of its inputs, and the same state materializes on every client and
every reload.

**Identity**: `ctx.senderDid` and `ctx.senderName` are verified by the host.
Anything inside `update.data` is peer-supplied and untrusted; validate shapes
and clamp values exactly as you would any network input.

**Determinism**: never call Math.random() for anything that peers must agree
on. Use `host.seededRandom(seed)` with a seed derived from message ids, so
every client computes the same outcome. Honest limit: the sender of a message
influences its id, so seeded outcomes are consistent and verifiable, not
adversarially fair.

**Size caps**: card payloads up to 16 KB, updates 4 KB, serialized as JSON.
Oversize sends are rejected by the host. Ship bytes through the file layer,
not through card payloads.

**Slash commands** register from the `commands` map; `/wheel a, b, c` calls
your handler with the raw argument string. Commands of disabled plugins do
not autocomplete and do not fire.

**Disabling**: users can toggle any plugin off in settings. Your cards then
render as a neutral fallback naming the plugin; nothing else breaks, and
other users are unaffected.

## Icons

`icon` accepts an emoji or any lucide icon as `lucide:<kebab-name>`
(https://lucide.dev/icons). Cost note: emoji are free; the first lucide icon
rendered on an instance lazy-loads a chunk containing the full icon set, paid
once and only by instances whose plugins use lucide names.

## Rules

- Do not import from `$lib/transport` internals. The host API is the surface;
  if it is missing something you need, extend the host, not your reach.
- No network calls in `reduce` (it replays; a replayed fetch is a bug).
  Fetching belongs in command handlers or card components, client-side.
- State must rebuild from updates alone. If you cache, cache derivations.
- Test your reducer as a pure function; the repo's vitest setup applies.

## Installing plugins from outside this repo

Set `PLUGIN_SOURCES` on the instance and redeploy - the build fetches each
source into this folder before bundling (the docker-minecraft-server model,
at build time because plugins compile into the app):

```
PLUGIN_SOURCES=https://github.com/you/awful-plugin-dice#v1,you/plugin-pack
```

- Accepted forms: a github url, `user/repo`, either with `#ref` (tag, branch,
  or commit - pin refs for reproducible deploys), or a local path in dev.
- A source can hold ONE plugin (manifest.ts at its root) or a PACK: plugin
  folders at the root or under `plugins/`.
- Removing an entry removes the plugin on the next deploy. Fetched plugins
  never overwrite the built-in ones, and a broken source fails the build
  loudly rather than silently shipping without it.
- Trust: a fetched plugin runs with the same trust as the app itself, in
  every user's browser, unsandboxed. Only list sources you trust like your
  own code.

Locally: `PLUGIN_SOURCES=... node scripts/fetch-plugins.mjs` then `pnpm dev`.
Fetched folders are gitignored automatically.

## Developing

`pnpm dev` in `frontend/` picks the folder up with hot reload. The registry
skips a plugin with a bad manifest and logs why. Redeploying the instance is
what publishes a plugin to your users.
