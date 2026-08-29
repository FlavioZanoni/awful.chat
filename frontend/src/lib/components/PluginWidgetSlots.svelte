<script lang="ts">
  import { Plus, X } from "@lucide/svelte";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import PluginWidgetBox from "./PluginWidgetBox.svelte";
  import { getRegistry, getManifest, getPlugin } from "$lib/plugins/registry";
  import {
    MAX_PINNED_WIDGETS,
    isPluginEnabled,
    pinWidget,
    pluginPrefs,
  } from "$lib/plugins/prefs.svelte";
  import { getPluginCardMessages } from "$lib/storage";
  import { roomsStore } from "$lib/rooms.svelte";
  import { MessageType } from "$lib/types/message";

  interface Candidate {
    pluginId: string;
    cardId: string;
    roomCode: string;
    roomName: string;
    timestamp: number;
  }

  const hasPlugins = getRegistry().size > 0;
  const emptySlots = $derived(
    Math.max(0, MAX_PINNED_WIDGETS - pluginPrefs.pinnedWidgets.length)
  );

  let pickerOpen = $state(false);
  let candidates = $state<Candidate[]>([]);
  let loading = $state(false);

  async function openPicker() {
    if (pickerOpen) {
      pickerOpen = false;
      return;
    }
    pickerOpen = true;
    loading = true;
    try {
      const rooms = [...roomsStore.rooms, ...roomsStore.dmRooms];
      const pinned = new Set(pluginPrefs.pinnedWidgets.map((p) => p.cardId));
      const found: Candidate[] = [];
      for (const room of rooms) {
        const cards = await getPluginCardMessages(room.roomCode);
        for (const msg of cards) {
          if (msg.type !== MessageType.PluginCard || pinned.has(msg.id))
            continue;
          try {
            const pluginId = (JSON.parse(msg.content) as { pluginId?: string })
              .pluginId;
            if (!pluginId || !isPluginEnabled(pluginId)) continue;
            found.push({
              pluginId,
              cardId: msg.id,
              roomCode: room.roomCode,
              roomName: room.name || room.roomCode,
              timestamp: msg.timestamp,
            });
          } catch {
            // Malformed card content: not pinnable.
          }
        }
      }
      found.sort((a, b) => b.timestamp - a.timestamp);
      // Only plugins that SHIP a widget surface are pickable - offering a
      // poll or roulette card with no compact view pinned a strip that
      // could show nothing but the plugin's name. And singleton plugins
      // (a watch-together) offer only their NEWEST card - old parties are
      // dead parties.
      const defs = new Map<
        string,
        { widget: boolean; singleton: boolean }
      >();
      const deduped: Candidate[] = [];
      for (const c of found) {
        if (!defs.has(c.pluginId)) {
          const def = await getPlugin(c.pluginId).catch(() => null);
          defs.set(c.pluginId, {
            widget: !!def?.widget,
            singleton: !!def?.singletonWidget,
          });
        }
        const d = defs.get(c.pluginId)!;
        if (!d.widget) continue;
        if (d.singleton && deduped.some((x) => x.pluginId === c.pluginId))
          continue;
        deduped.push(c);
      }
      candidates = deduped.slice(0, 20);
    } finally {
      loading = false;
    }
  }

  async function pick(c: Candidate) {
    const def = await getPlugin(c.pluginId).catch(() => null);
    pinWidget(
      { pluginId: c.pluginId, cardId: c.cardId, roomCode: c.roomCode },
      { replacePlugin: !!def?.singletonWidget }
    );
    pickerOpen = false;
  }
</script>

{#if hasPlugins}
  <!-- A wallet-style stack: collapsed, the pinned widgets overlap with only
       their top edges peeking; hovering the stack fans them out to full
       strips and reveals the empty dotted slots. -->
  <div class="group/stack shrink-0 border-t border-sidebar-border pt-2">
    <!-- Slots ABOVE the pins, pins at the bottom: this block sits at the
         sidebar's bottom, so anything that grows BELOW a pin shoves the pin
         upward exactly as the cursor reaches its controls. With the slots on
         top, hover-growth expands into the free space above and the pinned
         strips never move under the pointer. -->
    {#each Array.from({ length: emptySlots }) as _, i (i)}
      {@const alwaysOpen = pluginPrefs.pinnedWidgets.length === 0 && i === 0}
      <!-- Height-animated, not display-swapped: a display swap cannot
           transition, and with a single pinned card the slot reveal IS the
           stack animation. -->
      <button
        type="button"
        onclick={openPicker}
        aria-label="Pin a plugin to this slot"
        class="mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed font-mono text-[11px] text-muted-foreground/60 transition-all duration-200 hover:border-primary/50 hover:text-primary {alwaysOpen
          ? 'mb-1 h-8 border-border/70'
          : 'mb-0 h-0 border-transparent opacity-0 group-hover/stack:mb-1 group-hover/stack:h-8 group-hover/stack:border-border/70 group-hover/stack:opacity-100'}"
      >
        <Plus class="size-3" />
        pin
      </button>
    {/each}

    {#if pickerOpen}
      <div
        class="mx-2 mb-1 max-h-44 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
      >
        <div
          class="select-none flex items-center justify-between px-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
        >
          <span>Pin a plugin</span>
          <button
            type="button"
            onclick={() => (pickerOpen = false)}
            aria-label="Close picker"
            class="cursor-pointer rounded p-0.5 hover:text-destructive"
          >
            <X class="size-3" />
          </button>
        </div>
        {#if loading}
          <p class="animate-pulse px-2 py-1 font-mono text-[11px] text-muted-foreground">
            Looking for cards...
          </p>
        {:else if candidates.length === 0}
          <p class="px-2 py-1 font-mono text-[11px] text-muted-foreground">
            Nothing pinnable - only plugins with a sidebar widget show here
            (try /play).
          </p>
        {:else}
          {#each candidates as c (c.cardId)}
            {@const m = getManifest(c.pluginId)}
            <button
              type="button"
              onclick={() => pick(c)}
              class="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left hover:bg-muted"
            >
              <PluginIcon icon={m?.icon ?? "lucide:unplug"} class="size-3 shrink-0" />
              <span class="truncate font-mono text-[11px]"
                >{m?.name ?? c.pluginId}</span
              >
              <span
                class="ml-auto max-w-24 truncate font-mono text-[10px] text-muted-foreground"
                >{c.roomName}</span
              >
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    {#each pluginPrefs.pinnedWidgets as pin, i (pin.cardId)}
      <div
        class="relative transition-all duration-200 {i > 0
          ? '-mt-7 group-hover/stack:mt-0'
          : ''}"
        style="z-index: {30 - i}"
      >
        <PluginWidgetBox {pin} />
      </div>
    {/each}

  </div>
{/if}
