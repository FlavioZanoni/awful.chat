<script lang="ts">
  import type { ComponentType } from "svelte";
  import { X } from "@lucide/svelte";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import { getPlugin, getManifest } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import { isPluginEnabled, unpinWidget, type PinnedWidget } from "$lib/plugins/prefs.svelte";
  import { makeHostApi } from "$lib/plugins/host";
  import { requestJumpToMessage } from "$lib/ui-state.svelte";
  import { getMessage, getPluginCardMessages } from "$lib/storage";
  import { roomsStore } from "$lib/rooms.svelte";
  import { transportState } from "$lib/transport/transport.svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { MessageType } from "$lib/types/message";
  import type { Message } from "$lib/transport/transport.svelte";

  interface Candidate {
    cardId: string;
    roomCode: string;
    timestamp: number;
  }

  let { pin }: { pin: PinnedWidget } = $props();

  let card = $state<Message | null>(null);
  let widgetComponent = $state<ComponentType | null>(null);
  let widgetState = $state<unknown>(undefined);
  let gone = $state(false);
  // A card-backed widget with no live card yet: keep the strip mounted with
  // a quiet label instead of unpinning - the next party revives it.
  let waiting = $state(false);
  let needsCard = $state(false);

  // The pin names only a plugin; which card the strip shows is resolved
  // HERE, live. Waffle-style plugins follow the newest card that is theirs
  // (widgetMine on its folded state - "am I a member") and show NOTHING
  // otherwise: a strip with controls to a party the user is not in is a
  // remote control for someone else's music. Plugins without a mine notion
  // follow the newest card; card-less plugins (a soundboard) render with no
  // card whatsoever.
  let liveCardId = $state<string | null>(null);
  let liveRoomCode = $state("");
  let lastScan = 0;
  let scanSeq = 0;
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => () => {
    if (rescanTimer) clearTimeout(rescanTimer);
  });

  const manifest = $derived(getManifest(pin.pluginId));
  // One host per (plugin, room), not per render: a fresh host means a fresh
  // now-playing token, churning the OS media surface on every state tick.
  const hostApi = $derived(makeHostApi(pin.pluginId, liveRoomCode));

  // Same tick bridge as MsgRender: card state lives in a plain Map, this is
  // what repaints the box when votes/updates fold - including updates for
  // OTHER rooms, which fold too now that saved rooms stay joined.
  let tick = $state(0);
  $effect(() => onCardStateChange(() => (tick += 1)));

  $effect(() => {
    void tick;
    // Entering a room is a resolve trigger of its own: the party the pin
    // should follow is usually in the room just opened, and with no plugin
    // update folding there is otherwise no tick to rescan on.
    void transportState.roomCode;
    void (async () => {
      try {
        const plugin = await getPlugin(pin.pluginId);
        if (!plugin) {
          gone = true;
          return;
        }
        widgetComponent = (plugin.widget ?? null) as ComponentType | null;
        needsCard = !!plugin.card;

        // No card surface at all: the widget stands alone (device-local
        // plugins like the soundboard). Nothing to scan for.
        if (!plugin.card) return;

        // Throttled to one scan per 5s of ticks; while nothing changes,
        // the strip stays where it is.
        if (Date.now() - lastScan <= 5000) {
          // Trailing edge: a tick swallowed by the throttle still deserves a
          // scan once the window passes, or a join whose updates all land
          // inside the window (join + owner sync usually do) never moves
          // the strip until some unrelated plugin update fires.
          if (!rescanTimer)
            rescanTimer = setTimeout(
              () => {
                rescanTimer = null;
                tick += 1;
              },
              5100 - (Date.now() - lastScan)
            );
        } else {
          lastScan = Date.now();
          const seq = ++scanSeq;
          const found: Candidate[] = [];
          // roomsStore only mirrors SAVED rooms. The room the user is
          // standing in right now may not be saved - and it is the single
          // most likely place for the party they are in, so scan it too.
          const activeRoom = transportState.roomCode;
          const roomCodes = new Set<string>(activeRoom ? [activeRoom] : []);
          for (const room of [...roomsStore.rooms, ...roomsStore.dmRooms])
            roomCodes.add(room.roomCode);
          for (const roomCode of roomCodes) {
            for (const msg of await getPluginCardMessages(roomCode)) {
              if (msg.type !== MessageType.PluginCard) continue;
              try {
                const parsed = JSON.parse(msg.content) as { pluginId?: string };
                if (parsed.pluginId !== pin.pluginId) continue;
              } catch {
                continue;
              }
              found.push({
                cardId: msg.id,
                roomCode,
                timestamp: msg.timestamp,
              });
            }
          }
          found.sort((a, b) => b.timestamp - a.timestamp);
          const selfDid = identityStore.did || "";
          let picked: Candidate | null = null;
          // Cap the widgetMine probes: each cache-miss getCardState folds a
          // card's full update history, and a room spammed with stray cards
          // must not turn every rescan into that N times over. The active
          // room is exempt from the cap - the party you are in is almost
          // always in the room you are standing in, and old test cards
          // elsewhere must not push it out of the probe window.
          for (const c of found.filter(
            (c, i) => i < 8 || c.roomCode === activeRoom
          )) {
            if (plugin.widgetMine) {
              const state = await getCardState(c.cardId, c.roomCode, plugin);
              if (!plugin.widgetMine(state, selfDid)) continue;
            }
            picked = c;
            break;
          }
          // A newer scan may have started while this one awaited: the last
          // writer would win regardless of staleness, silently un-following
          // what the newer scan found.
          if (seq !== scanSeq) return;
          if (picked && picked.cardId !== liveCardId) {
            liveCardId = picked.cardId;
            liveRoomCode = picked.roomCode;
            card = null;
          } else if (!picked && plugin.widgetMine && liveCardId) {
            // Nothing is "mine" anymore (left the party, or it closed):
            // release the strip rather than keep CONTROLS to a party the
            // user is not in. No newest-card fallback for mine-aware
            // plugins for the same reason - the strip is "the party I am
            // in", never "someone's party nearby".
            liveCardId = null;
            liveRoomCode = "";
            card = null;
          } else if (!picked && !plugin.widgetMine) {
            // Plugins without a mine notion keep the newest-card behavior.
            const fallback = found[0] ?? null;
            if (fallback && fallback.cardId !== liveCardId) {
              liveCardId = fallback.cardId;
              liveRoomCode = fallback.roomCode;
              card = null;
            }
          }
        }

        if (!liveCardId) {
          waiting = true;
          return;
        }
        const msg = card ?? (await getMessage(liveCardId)) ?? null;
        if (!msg) {
          // The card's room was deleted; wait for the next one.
          waiting = true;
          card = null;
          return;
        }
        waiting = false;
        card = msg;
        widgetState = await getCardState(liveCardId, liveRoomCode, plugin);
      } catch {
        gone = true;
      }
    })();
  });

  // Widgets are a STRIP, not a card: only a dedicated compact view renders.
  // A card-backed widget also needs its card loaded before mounting - it
  // must NEVER render with card: null, whatever the scan's timing.
  const ready = $derived(
    !!widgetComponent && !waiting && (!needsCard || card !== null)
  );
</script>

{#if !gone && isPluginEnabled(pin.pluginId)}
  <!-- One connection-status-sized row: icon, the plugin's strip, unpin. -->
  <!-- Solid bg + shadow: in the collapsed stack only this card's top edge
       peeks out, and a translucent card would vanish against the sidebar. -->
  <div
    class="mx-2 mb-1 flex h-8 items-center gap-1.5 overflow-hidden rounded-md border border-primary/25 bg-card shadow-sm px-2"
  >
    {#if card && liveCardId}
      <!-- The icon is the way BACK to the card: the strip has room for a
           play button, not the queue - one click puts the full controls on
           screen, scrolled to and flashed. -->
      <button
        type="button"
        onclick={() => requestJumpToMessage(liveRoomCode, liveCardId!)}
        aria-label={`Go to the ${manifest?.name ?? pin.pluginId} card`}
        title={`Go to the ${manifest?.name ?? pin.pluginId} card`}
        class="shrink-0 cursor-pointer text-muted-foreground hover:text-primary"
      >
        <PluginIcon icon={manifest?.icon ?? "lucide:unplug"} class="size-3" />
      </button>
    {:else}
      <PluginIcon
        icon={manifest?.icon ?? "lucide:unplug"}
        class="size-3 shrink-0 text-muted-foreground"
      />
    {/if}
    <div class="min-w-0 flex-1 overflow-hidden">
      {#if ready && widgetComponent}
        {@const WidgetUi = widgetComponent}
        <WidgetUi
          {card}
          cardState={widgetState}
          host={hostApi}
        />
      {:else if waiting}
        <span class="truncate font-mono text-[11px] text-muted-foreground">
          {manifest?.name ?? pin.pluginId} · idle
        </span>
      {:else}
        <span class="animate-pulse font-mono text-[11px] text-muted-foreground">
          Loading...
        </span>
      {/if}
    </div>
    <button
      type="button"
      onclick={() => unpinWidget(pin.pluginId)}
      aria-label="Unpin widget"
      class="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-destructive"
    >
      <X class="size-3" />
    </button>
  </div>
{/if}
