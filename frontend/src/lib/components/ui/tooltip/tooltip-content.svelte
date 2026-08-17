<script lang="ts">
  import { Tooltip as TooltipPrimitive } from "bits-ui";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  let {
    ref = $bindable(null),
    class: className,
    sideOffset = 6,
    children,
    ...restProps
  }: WithoutChildrenOrChild<TooltipPrimitive.ContentProps> & {
    children: Snippet;
  } = $props();
</script>

<TooltipPrimitive.Portal>
  <TooltipPrimitive.Content
    bind:ref
    {sideOffset}
    class={cn(
      "bg-popover text-popover-foreground border-border z-100 w-fit max-w-64 rounded-md border px-2 py-1 text-xs font-mono shadow-md",
      "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0",
      className
    )}
    {...restProps}
  >
    {@render children()}
  </TooltipPrimitive.Content>
</TooltipPrimitive.Portal>
