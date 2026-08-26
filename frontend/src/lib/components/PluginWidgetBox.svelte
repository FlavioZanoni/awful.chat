<script lang="ts">
  import type { ComponentType } from "svelte";
  import { X } from "@lucide/svelte";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import { getPlugin, getManifest } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import { isPluginEnabled, unpinWidget, type PinnedWidget } from "$lib/plugins/prefs.svelte";
  import { makeHostApi } from "$lib/plugins/host";
  import { getMessage } from "$lib/storage";
  import type { Message } from "$lib/transport/transport.svelte";

  let { pin }: { pin: PinnedWidget } = $props();

  let card = $state<Message | null>(null);
  let widgetComponent = $state<ComponentType | null>(null);
  let widgetState = $state<unknown>(undefined);
  let gone = $state(false);

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
        const msg = card ?? (await getMessage(pin.cardId)) ?? null;
        if (!msg) {
          // The card's room was deleted: the pin points at nothing.
          gone = true;
          return;
        }
        card = msg;
        widgetState = await getCardState(pin.cardId, pin.roomCode, plugin);
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
          host={makeHostApi(pin.pluginId, pin.roomCode)}
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
