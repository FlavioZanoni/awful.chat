<script lang="ts">
  /**
   * Convenience wrapper for the common case: one icon button, one label.
   *
   * The trigger props are handed to the child rather than rendered as their own
   * button, so the tooltip attaches to the real control - no nested buttons,
   * and it still opens on keyboard focus.
   *
   *   <Tip text="Leave room">
   *     {#snippet children(props)}
   *       <Button {...props} variant="ghost" size="icon">...</Button>
   *     {/snippet}
   *   </Tip>
   */
  import { Tooltip as TooltipPrimitive } from "bits-ui";
  import TooltipContent from "./tooltip-content.svelte";
  import type { Snippet } from "svelte";

  let {
    text,
    side = "top",
    delayDuration = 250,
    disabled = false,
    children,
  }: {
    text: string;
    side?: "top" | "right" | "bottom" | "left";
    delayDuration?: number;
    /** Skip the tooltip entirely (e.g. on touch devices). */
    disabled?: boolean;
    children: Snippet<[Record<string, unknown>]>;
  } = $props();
</script>

{#if disabled || !text}
  {@render children({})}
{:else}
  <!-- Provider lives here so a Tip works anywhere: bits-ui throws
       'Context "Tooltip.Provider" not found' at render time without it, which
       takes the whole component tree down, not just the tooltip. -->
  <TooltipPrimitive.Provider {delayDuration}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger>
        {#snippet child({ props })}
          {@render children(props)}
        {/snippet}
      </TooltipPrimitive.Trigger>
      <TooltipContent {side}>{text}</TooltipContent>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
{/if}
