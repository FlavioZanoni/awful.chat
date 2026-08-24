<script lang="ts">
  import { transportState } from "$lib/transport/transport.svelte";
  import { profileStore } from "$lib/profile.svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { nameEffectStyle } from "$lib/name-effect";
  import { Copy, Check, MessageSquare, UserPlus, UserRoundMinus } from "@lucide/svelte";
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
    /** Absent = the action is unavailable (self, or peer not connected). */
    onMessage?: () => void;
    onTogglePhonebook?: () => void;
    inPhonebook?: boolean;
  }

  let {
    open = false,
    onOpenChange,
    did,
    name,
    avatarUrl,
    color,
    onMessage,
    onTogglePhonebook,
    inPhonebook = false,
  }: Props = $props();

  // Our own metadata never enters peerProfileMeta (that map is fed by the
  // wire); clicking your own row reads the local profile instead.
  const isSelf = $derived(did === identityStore.did);
  const profileMeta = $derived(
    isSelf
      ? {
          bannerUrl: profileStore.bannerUrl ?? undefined,
          tagText: profileStore.tagText ?? undefined,
          tagTextColor: profileStore.tagTextColor ?? undefined,
          tagChipColor: profileStore.tagChipColor ?? undefined,
          bio: profileStore.bio ?? undefined,
          nameEffect: profileStore.nameEffect ?? undefined,
          gradient2: profileStore.gradient2 ?? undefined,
          gradient3: profileStore.gradient3 ?? undefined,
        }
      : transportState.peerProfileMeta.get(did)
  );

  const effectStyle = $derived(
    nameEffectStyle(
      profileMeta?.nameEffect,
      color,
      profileMeta?.gradient2,
      profileMeta?.gradient3
    )
  );

  const bannerUrl = $derived(profileMeta?.bannerUrl);
  const tagText = $derived(profileMeta?.tagText);
  const tagTextColor = $derived(profileMeta?.tagTextColor ?? "#000000");
  const tagChipColor = $derived(profileMeta?.tagChipColor ?? "#e5e7eb");
  const bio = $derived(profileMeta?.bio);

  let copied = $state(false);
  async function copyDid() {
    try {
      await navigator.clipboard.writeText(did);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard blocked: nothing to do, the did is visible to select.
    }
  }
</script>

<Dialog {open} onOpenChange={(newOpen) => onOpenChange(newOpen)}>
  <DialogContent class="sm:max-w-md">
    <DialogHeader>
      <DialogTitle class="sr-only">Profile</DialogTitle>
    </DialogHeader>

    <div class="flex flex-col gap-3">
      <!-- Banner always renders (gradient fallback), the avatar overlaps its
           bottom-left - same composition as the settings editor card. -->
      <div
        class="w-full h-24 rounded-lg overflow-hidden bg-linear-to-r from-primary/20 to-secondary/40"
      >
        {#if bannerUrl}
          <img
            src={bannerUrl}
            alt="Profile banner"
            class="w-full h-full object-cover"
          />
        {/if}
      </div>

      <div
        class="-mt-13 ml-3 flex size-20 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-4 ring-background shrink-0"
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

      <div class="flex flex-wrap items-center gap-2 px-1">
        <span
          class="text-lg font-mono font-semibold {effectStyle.class}"
          style={effectStyle.style || (color ? `color: ${color}` : "")}
        >
          {name}
        </span>
        {#if tagText}
          <div
            class="px-2 py-1 rounded text-xs font-mono font-semibold uppercase"
            style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
          >
            {tagText}
          </div>
        {/if}
      </div>

      {#if !isSelf && (onMessage || onTogglePhonebook)}
        <div class="flex items-center gap-2 px-1">
          {#if onMessage}
            <button
              type="button"
              onclick={onMessage}
              class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <MessageSquare class="size-3.5" />
              Message
            </button>
          {/if}
          {#if onTogglePhonebook}
            <button
              type="button"
              onclick={onTogglePhonebook}
              class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-xs transition-colors {inPhonebook
                ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                : 'border-border text-foreground hover:bg-muted'}"
            >
              {#if inPhonebook}
                <UserRoundMinus class="size-3.5" />
                Remove contact
              {:else}
                <UserPlus class="size-3.5" />
                Add to phonebook
              {/if}
            </button>
          {/if}
        </div>
      {/if}

      {#if bio}
        <div class="px-1 text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {bio}
        </div>
      {/if}

      <div
        class="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5"
      >
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {did}
        </span>
        <button
          type="button"
          onclick={copyDid}
          aria-label="Copy DID"
          class="shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {#if copied}
            <Check class="size-3.5 text-primary" />
          {:else}
            <Copy class="size-3.5" />
          {/if}
        </button>
      </div>
    </div>
  </DialogContent>
</Dialog>
