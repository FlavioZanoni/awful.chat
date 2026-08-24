<script lang="ts">
  import { transportState } from "$lib/transport/transport.svelte";
  import { nameEffectStyle } from "$lib/name-effect";
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    did: string;
    name: string;
    avatarUrl?: string;
    color?: string;
  }

  let { open = false, onOpenChange, did, name, avatarUrl, color }: Props = $props();

  const profileMeta = $derived(transportState.peerProfileMeta.get(did));

  const effectStyle = $derived(nameEffectStyle(profileMeta?.nameEffect, color));

  const bannerUrl = $derived(profileMeta?.bannerUrl);
  const tagText = $derived(profileMeta?.tagText);
  const tagTextColor = $derived(profileMeta?.tagTextColor ?? "#000000");
  const tagChipColor = $derived(profileMeta?.tagChipColor ?? "#e5e7eb");
  const bio = $derived(profileMeta?.bio);
</script>

<Dialog {open} onOpenChange={(newOpen) => onOpenChange(newOpen)}>
  <DialogContent class="sm:max-w-md">
    <DialogHeader>
      <DialogTitle class="sr-only">Profile</DialogTitle>
    </DialogHeader>

    <div class="flex flex-col gap-4">
      {#if bannerUrl}
        <div
          class="w-full h-24 rounded-lg overflow-hidden bg-muted/30"
        >
          <img
            src={bannerUrl}
            alt="Profile banner"
            class="w-full h-full object-cover"
          />
        </div>
      {/if}

      <div class="flex flex-col items-center gap-2">
        <div
          class="flex size-20 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border shrink-0"
        >
          {#if avatarUrl}
            <img
              src={avatarUrl}
              alt={name}
              class="size-full object-cover"
            />
          {:else}
            <span
              class="text-2xl font-semibold text-primary font-mono select-none"
            >
              {(name || "?").charAt(0).toUpperCase()}
            </span>
          {/if}
        </div>

        <div class="flex flex-col items-center gap-1">
          <div class="flex items-center gap-2">
            <span
              class="text-lg font-mono font-semibold text-center {effectStyle.class}"
              style={effectStyle.style || (color ? `color: ${color}` : "")}
            >
              {name}
            </span>
            {#if tagText}
              <div
                class="px-2 py-1 rounded text-xs font-mono font-semibold"
                style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
              >
                {tagText}
              </div>
            {/if}
          </div>
        </div>
      </div>

      {#if bio}
        <div class="text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {bio}
        </div>
      {/if}
    </div>
  </DialogContent>
</Dialog>

<style>
  :global(.name-effect-gradient) {
    background: linear-gradient(90deg, var(--color-from), var(--color-to));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  :global(.name-effect-shimmer) {
    animation: shimmer 2s infinite;
  }

  :global(.name-effect-glow) {
    animation: glow 2s ease-in-out infinite;
  }

  :global(.name-effect-rainbow) {
    animation: rainbow 3s linear infinite;
  }
</style>
