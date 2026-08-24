# Plugin surface plan

Instance-shipped client plugins, "Minecraft mods" model: a `frontend/plugins/`
folder, bundled at build time, served to every user of the instance. No
third-party code at runtime, no server-side plugin logic, no sandboxing:
plugins share the exact trust level of the app bundle itself, because the
operator already ships all the code every visitor runs.

## Goals

- Adding a plugin = dropping a folder in `frontend/plugins/` and redeploying.
- Plugins can define chat cards, react to updates from other peers, and add
  slash commands, without touching the wire layer or core files.
- Users see a "Plugins" panel in settings: icon, name, description, per-user
  enable toggle.
- Two reference plugins prove the API: wheel (deterministic shared outcome)
  and poll (multi-peer persisted state).

## Non-goals (v1)

- Runtime plugin loading without redeploy, marketplaces, permissions UI.
- Surfaces outside chat: sidebar panels, call-view widgets, settings pages,
  message transforms.
- Server-side plugin components.
- Cross-instance version negotiation beyond the fallback card.

## 1. Loader and registry

New: `frontend/src/lib/plugins/registry.ts`.

- Discovery: `import.meta.glob("../../../plugins/*/index.ts")` in lazy mode.
  Vite splits each plugin into its own hashed chunk, downloaded on first use,
  deps shared with the app (same pattern as the webtorrent/mediasoup lazy
  imports). Manifests must be available WITHOUT loading plugin code, so each
  plugin also has `manifest.ts` loaded eagerly via a second glob with
  `{ eager: true }`: tiny objects, no code.
- `definePlugin(def)` in `src/lib/plugins/api.ts` is the typed entry:

```ts
interface PluginManifest {
  id: string;           // ^[a-z0-9-]{2,32}$, folder name must match
  name: string;
  description: string;  // one line, shown in settings
  icon: string;         // emoji, keeps v1 free of asset plumbing
  apiVersion: 1;
}

interface PluginDefinition {
  manifest: PluginManifest;
  // Svelte component rendering a card. Props: { card, state, host }.
  card?: Component;
  // Pure reducer. Host feeds persisted updates in lamport order (history
  // replay first, then live), ephemeral updates live only.
  reduce?: (state: unknown, update: PluginUpdate, ctx: UpdateCtx) => unknown;
  initialState?: () => unknown;
  commands?: Record<string, (args: string, host: HostApi) => void | Promise<void>>;
}

interface UpdateCtx {
  senderDid: string;     // host-verified, never from payload
  senderName: string;
  updateId: string;      // message id, stable across peers
  lamport: number;
  ephemeral: boolean;
}

interface HostApi {
  sendCard(payload: unknown): Promise<string>;          // returns cardId
  sendUpdate(cardId: string, payload: unknown, opts?: { ephemeral?: boolean }): Promise<void>;
  roomCode(): string;
  selfDid(): string;
  peers(): Array<{ did: string; name: string }>;
  seededRandom(seed: string): () => number;             // deterministic PRNG
  storage: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
}
```

- Registry validates manifests at startup (id regex, unique, apiVersion
  match); a bad plugin is skipped with a console error, never crashes boot.
- apiVersion gate: loader refuses mismatched plugins with a settings-panel
  note instead of undefined behavior.

## 2. Wire protocol

Two new chat-class message types plus one ephemeral type in
`src/lib/types/message.ts` (enum at line 3, `isChatMessage` at 314):

- `PluginCard = "plugin_card"`: persisted, added to `isChatMessage`, so it
  syncs through digests/batches and appears in history automatically.
- `PluginUpdate = "plugin_update"`: persisted chat-class, same treatment.
- `PluginEphemeral = "plugin_ephemeral"`: wire only, routed in the presence
  switch of `_handleChatMessage`'s dispatcher, never stored.

Payload placement: the JSON payload is stringified into `msg.content`, as
`{ pluginId, cardId?, data }`. This is deliberate: `canonicalContentV2`
(messaging.ts) already signs `content`, so plugin payloads are covered by the
existing v2 signature with zero signature-format changes. `cardId` for updates
is the card's message id.

Host-side validation on receive (mirror of profile-meta: pure function
`src/lib/plugins/validate.ts`, unit tested):
- content parses as JSON, pluginId matches `^[a-z0-9-]{2,32}$`
- caps: card payload <= 16 KB, update <= 4 KB, ephemeral <= 4 KB (JSON string
  length). Oversize is dropped with a console warn.
- Sender identity comes exclusively from the verified message path (senderId
  and the peerId-DID binding), NEVER from the payload. Same rule the DM layer
  enforces.
- Unknown or disabled pluginId: card renders the fallback ("uses the X
  plugin"); updates and ephemerals are dropped. Old builds ignore unknown
  message types entirely (dispatcher default), so mixed-version rooms degrade
  to "plugin cards invisible on old clients", acceptable for a same-instance
  user base.

## 3. Card state

New: `src/lib/plugins/state.svelte.ts`.

- Per-card state store: `cardStates: Map<cardId, unknown>` in a $state map.
- On first render of a card, the host queries storage for all PluginUpdate
  messages in that room referencing the cardId (the reaction pattern:
  `getAllMessages(roomCode)` filter), sorts by lamport (ties: message id),
  folds through the plugin's `reduce`, caches the result.
- Live updates (own sends included) fold incrementally. Ephemeral updates
  fold but are marked so a rebuild from storage does not expect them.
- Determinism rule for reference plugins: any randomness derives from
  `seededRandom(messageId)`. Same fold order + same seeds = identical state on
  every client, late joiners included.

## 4. Rendering

`MsgRender.svelte` gets a `PluginCard` branch: look up pluginId in the
registry, lazy-load the plugin chunk (skeleton while loading), mount the
card component with `{ card, state, host }`. Fallback card for unknown or
disabled plugins shows icon-less neutral chip with the plugin id. Card width
constraints match existing file cards. PluginUpdate messages render nothing
(they are data, not chat lines), but they must not break pagination or unread
counts: they are excluded from the unread badge the same way reactions are
(verify how Reaction is counted and mirror it).

## 5. Slash commands

- `ChatView.svelte` composer: on send, if the text matches `^/([a-z0-9-]+)\s?(.*)$`
  and the command is registered by an enabled plugin, invoke the handler
  instead of sending a text message. Unknown command: inline hint under the
  composer, message not sent (prevents leaking typos as public messages).
- Autocomplete: when the composer starts with "/", a small popup lists
  matching commands with plugin icon and description, keyboard navigable.
  Reuses the mention/emoji popup pattern if one exists, otherwise a minimal
  list styled like EmojiPickerPopup.

## 6. Settings panel

- `SettingsDialog.svelte` (tabs at line 58): new tab "Plugins" with a Puzzle
  icon, new component `src/lib/components/settings/PluginSettings.svelte`.
- Lists every discovered manifest: icon, name, description, version, and a
  toggle. Toggle state is device-local (display-prefs pattern,
  `awful:plugin-disabled:v1` key holding a JSON array of disabled ids, in
  `src/lib/plugins/prefs.svelte.ts`).
- Disabled = fallback rendering + commands removed from autocomplete and
  dispatch. Other peers unaffected.

## 7. Reference plugins

`frontend/plugins/wheel/`:
- `/wheel Valorant, CS2, Deep Rock` posts a card with the options.
- Card shows the wheel; any participant can hit "Spin" once per card: the
  FIRST spin update in lamport order wins, later spins are no-ops in the
  reducer. Winner index = `Math.floor(seededRandom(spinUpdateId)() * options.length)`.
  The animation eases onto the predetermined winner. Result line names the
  winner and who spun.

`frontend/plugins/poll/`:
- `/poll Question? A, B, C` posts a card.
- Vote buttons send persisted updates `{ vote: i }`; reducer keeps last vote
  per senderDid; card shows live tallies and who voted (names, since rooms
  are small).

## 8. Tests and verification

- Unit: validate.ts caps and shapes; seededRandom stability (fixed vectors);
  wheel reducer (first spin wins, deterministic winner); poll reducer (last
  vote per did). Registry: duplicate id, bad manifest skipped.
- svelte-check 0/0, tsc no new errors, vitest, vite build.
- Manual two-browser check for the live update path (documented, not
  automated: the harness cannot run two full clients against gossipsub in CI
  today).

## 9. Risks and open questions

- PluginUpdate as chat-class messages inflate room history (a busy poll =
  dozens of stored rows). Accepted for v1: reactions already behave this way.
  If it hurts, compaction is a later, isolated change.
- Ephemeral routing adds a message type to the presence switch: verify it is
  excluded from every chat-side effect (unread, digests, notify rules).
- `content` holding JSON means old clients that DID know the type would show
  raw JSON: not a case that exists (new types), noted for future type reuse.
- Lamport tie-break must be deterministic (lamport, then message id) or two
  clients can fold updates in different orders. The fold sort is the single
  most correctness-critical line in the plan.
