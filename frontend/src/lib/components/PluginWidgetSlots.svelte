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

  const hasPlugins = getRegistry().size > 0;
  const emptySlots = $derived(
    Math.max(0, MAX_PINNED_WIDGETS - pluginPrefs.pinnedWidgets.length)
  );

  let pickerOpen = $state(false);
  let candidates = $state<string[]>([]);
  let loading = $state(false);

  // Pins name PLUGINS, so the picker lists plugins, not cards: every enabled
  // plugin that ships a widget surface and is not already pinned. Which card
  // (if any) the strip shows is the widget box's business, resolved live -
  // pinning used to require hunting for an existing card first, and froze
  // the pin to it.
  async function openPicker() {
    if (pickerOpen) {
      pickerOpen = false;
      return;
    }
    pickerOpen = true;
    loading = true;
    try {
      const pinned = new Set(pluginPrefs.pinnedWidgets.map((p) => p.pluginId));
      const found: string[] = [];
      for (const pluginId of getRegistry().keys()) {
        if (pinned.has(pluginId) || !isPluginEnabled(pluginId)) continue;
        const def = await getPlugin(pluginId).catch(() => null);
        // Only plugins that SHIP a widget surface are pickable - a plugin
        // with no compact view would pin a strip showing nothing but a name.
        if (def?.widget) found.push(pluginId);
      }
      candidates = found;
    } finally {
      loading = false;
    }
  }

  function pick(pluginId: string) {
    pinWidget(pluginId);
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
            Nothing pinnable - only plugins with a sidebar widget show here.
          </p>
        {:else}
          {#each candidates as pluginId (pluginId)}
            {@const m = getManifest(pluginId)}
            <button
              type="button"
              onclick={() => pick(pluginId)}
              class="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left hover:bg-muted"
            >
              <PluginIcon icon={m?.icon ?? "lucide:unplug"} class="size-3 shrink-0" />
              <span class="truncate font-mono text-[11px]"
                >{m?.name ?? pluginId}</span
              >
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    {#each pluginPrefs.pinnedWidgets as pin, i (pin.pluginId)}
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
