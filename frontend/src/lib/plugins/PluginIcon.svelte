<script lang="ts">
  import type { Component } from "svelte";

  interface Props {
    icon: string;
    class?: string;
  }

  let { icon, class: klass = "size-4" }: Props = $props();

  const lucideName = $derived(
    icon.startsWith("lucide:") ? icon.slice("lucide:".length) : null
  );
  let LucideIcon = $state<Component | null>(null);

  $effect(() => {
    const name = lucideName;
    if (!name) {
      LucideIcon = null;
      return;
    }
    void import("./lucide-icons").then(({ lucideByName }) => {
      LucideIcon = lucideByName(name);
    });
  });
</script>

{#if lucideName}
  {#if LucideIcon}
    <LucideIcon class={klass} />
  {/if}
{:else}
  <span class="leading-none">{icon}</span>
{/if}
