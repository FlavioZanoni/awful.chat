<script lang="ts">
  import type { ComponentType } from "svelte";
  import { getPlugin } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import { makeHostApi } from "$lib/plugins/host";
  import { getMessage } from "$lib/storage";
  import type { Message } from "$lib/transport/transport.svelte";

  let {
    pluginId,
    cardId,
    roomCode,
  }: { pluginId: string; cardId: string; roomCode: string } = $props();

  let card = $state<Message | null>(null);
  let tileComponent = $state<ComponentType | null>(null);
  let tileState = $state<unknown>(undefined);

  // Same tick bridge as MsgRender/PluginWidgetBox: repaint when updates fold.
  let tick = $state(0);
  $effect(() => onCardStateChange(() => (tick += 1)));

  $effect(() => {
    void tick;
    void (async () => {
      try {
        const plugin = await getPlugin(pluginId);
        if (!plugin?.callTile) return;
        card = card ?? (await getMessage(cardId)) ?? null;
        if (!card) return;
        tileState = await getCardState(cardId, roomCode, plugin);
        tileComponent = plugin.callTile as ComponentType;
      } catch (err) {
        console.warn("[plugins] call tile load failed:", err);
      }
    })();
  });
</script>

{#if tileComponent && card}
  {@const TileUi = tileComponent}
  <TileUi {card} cardState={tileState} host={makeHostApi(pluginId, roomCode)} />
{:else}
  <div
    class="grid h-full w-full place-items-center font-mono text-xs text-muted-foreground"
  >
    Loading...
  </div>
{/if}
