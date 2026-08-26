<script lang="ts">
  import type { ComponentType } from "svelte";
  import { X } from "@lucide/svelte";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import { getPlugin, getManifest } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import { isPluginEnabled, unpinWidget, type PinnedWidget } from "$lib/plugins/prefs.svelte";
  import { makeHostApi } from "$lib/plugins/host";
  import { getMessage, getPluginCardMessages } from "$lib/storage";
  import { roomsStore } from "$lib/rooms.svelte";
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

  // Singleton widgets pin the PLUGIN, not a card: when one party ends and a
  // new one starts (a new card, maybe in another room), the strip follows.
  // The pin's stored cardId is just the starting point (the slot list keys
  // each box by pin.cardId, so `pin` never changes under a mounted box).
  // svelte-ignore state_referenced_locally
  let liveCardId = $state(pin.cardId);
  // svelte-ignore state_referenced_locally
  let liveRoomCode = $state(pin.roomCode);
  let lastScan = 0;
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => () => {
    if (rescanTimer) clearTimeout(rescanTimer);
  });

  const manifest = $derived(getManifest(pin.pluginId));

  // Same tick bridge as MsgRender: card state lives in a plain Map, this is
  // what repaints the box when votes/updates fold - including updates for
  // OTHER rooms, which fold too now that saved rooms stay joined.
  let tick = $state(0);
  $effect(() => onCardStateChange(() => (tick += 1)));

  $effect(() => {
    void tick;
    void (async () => {
      try {
        const plugin = await getPlugin(pin.pluginId);
        if (!plugin) {
          gone = true;
          return;
        }
        // The strip follows the newest card the plugin says is YOURS
        // (widgetMine on its folded state - for waffle, "am I a member"),
        // so ending one party and joining another moves the widget with
        // you. Throttled to one scan per 5s of ticks; while no card
        // matches, the strip stays where it is.
        if (plugin.singletonWidget && Date.now() - lastScan <= 5000) {
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
        } else if (plugin.singletonWidget) {
          lastScan = Date.now();
          const found: Candidate[] = [];
          for (const room of [...roomsStore.rooms, ...roomsStore.dmRooms]) {
            for (const msg of await getPluginCardMessages(room.roomCode)) {
              if (msg.type !== MessageType.PluginCard) continue;
              try {
                const parsed = JSON.parse(msg.content) as { pluginId?: string };
                if (parsed.pluginId !== pin.pluginId) continue;
              } catch {
                continue;
              }
              found.push({
                cardId: msg.id,
                roomCode: room.roomCode,
                timestamp: msg.timestamp,
              });
            }
          }
          found.sort((a, b) => b.timestamp - a.timestamp);
          const selfDid = identityStore.did || "";
          let picked: Candidate | null = null;
          for (const c of found) {
            if (plugin.widgetMine) {
              const state = await getCardState(c.cardId, c.roomCode, plugin);
              if (!plugin.widgetMine(state, selfDid)) continue;
            }
            picked = c;
            break;
          }
          if (picked && picked.cardId !== liveCardId) {
            liveCardId = picked.cardId;
            liveRoomCode = picked.roomCode;
            card = null;
          }
        }
        const msg = card ?? (await getMessage(liveCardId)) ?? null;
        if (!msg) {
          // The card's room was deleted: the pin points at nothing.
          gone = true;
          return;
        }
        card = msg;
        widgetState = await getCardState(liveCardId, liveRoomCode, plugin);
        // Widgets are a STRIP, not a card: only a dedicated compact view
        // renders here. A plugin without one shows a plain label - falling
        // back to the chat card filled the sidebar with a full card, which
        // is the wrong shape for this surface.
        widgetComponent = (plugin.widget ?? null) as ComponentType | null;
      } catch {
        gone = true;
      }
    })();
  });
</script>

{#if !gone && isPluginEnabled(pin.pluginId)}
  <!-- One connection-status-sized row: icon, the plugin's strip, unpin. -->
  <!-- Solid bg + shadow: in the collapsed stack only this card's top edge
       peeks out, and a translucent card would vanish against the sidebar. -->
  <div
    class="mx-2 mb-1 flex h-8 items-center gap-1.5 overflow-hidden rounded-md border border-primary/25 bg-card shadow-sm px-2"
  >
    <PluginIcon
      icon={manifest?.icon ?? "🔌"}
      class="size-3 shrink-0 text-muted-foreground"
    />
    <div class="min-w-0 flex-1 overflow-hidden">
      {#if widgetComponent && card}
        {@const WidgetUi = widgetComponent}
        <WidgetUi
          {card}
          cardState={widgetState}
          host={makeHostApi(pin.pluginId, liveRoomCode)}
        />
      {:else if card}
        <span class="truncate font-mono text-[11px] text-muted-foreground">
          {manifest?.name ?? pin.pluginId}
        </span>
      {:else}
        <span class="animate-pulse font-mono text-[11px] text-muted-foreground">
          Loading...
        </span>
      {/if}
    </div>
    <button
      type="button"
      onclick={() => unpinWidget(pin.cardId)}
      aria-label="Unpin widget"
      class="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-destructive"
    >
      <X class="size-3" />
    </button>
  </div>
{/if}
