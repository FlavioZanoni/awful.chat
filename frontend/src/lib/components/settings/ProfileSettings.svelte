<script lang="ts">
  import { onDestroy } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import {
    profileStore,
    saveName,
    saveColor,
    saveBanner,
    saveTag,
    saveTagColors,
    saveBio,
    saveNameEffect,
    saveGradientColors,
  } from "$lib/profile.svelte";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import { identityStore, lock } from "$lib/identity/identity.svelte";
  import { nameEffectStyle } from "$lib/name-effect";
  import {
    Camera,
    Check,
    Copy,
    LogOut,
    Pencil,
    Plus,
    Trash2,
  } from "@lucide/svelte";

  interface Props {
    isMobile?: boolean;
    avatarDialogOpen?: boolean;
    onAvatarClick?: () => void;
  }

  let { isMobile = false, onAvatarClick }: Props = $props();

  let nameValue = $state("");
  let colorValue = $state("#3b82f6");
  let tagText = $state("");
  let tagTextColor = $state("#000000");
  let tagChipColor = $state("#e5e7eb");
  let bio = $state("");
  let nameEffect = $state("none");

  $effect(() => {
    // Never let a store echo stomp an edit in progress: saveTag() mutates
    // the store mid-commit, which re-ran this sync and reset the color
    // locals to their OLD values before saveTagColors read them.
    if (editing) return;
    nameValue = profileStore.nickname;
    colorValue = profileStore.color ?? "#3b82f6";
    tagText = profileStore.tagText ?? "";
    tagTextColor = profileStore.tagTextColor ?? "#000000";
    tagChipColor = profileStore.tagChipColor ?? "#e5e7eb";
    bio = profileStore.bio ?? "";
    nameEffect = profileStore.nameEffect ?? "none";
    gradient2Value = profileStore.gradient2 ?? "#a855f7";
    gradient3Value = profileStore.gradient3 ?? null;
  });

  const EFFECTS = ["none", "gradient", "shimmer", "glow", "rainbow"] as const;

  async function pickEffect(effect: string) {
    nameEffect = effect;
    await saveNameEffect(effect === "none" ? undefined : effect);
    if (effect === "gradient") {
      await saveGradientColors(gradient2Value, gradient3Value ?? undefined);
    }
  }

  async function commitGradients() {
    await saveGradientColors(gradient2Value, gradient3Value ?? undefined);
  }

  /** The card IS the editor: exactly one piece is in edit mode at a time. */
  let editing = $state<null | "name" | "tag" | "bio">(null);
  let bannerPickerOpen = $state(false);
  let gradient2Value = $state("#a855f7");
  let gradient3Value = $state<string | null>(null);

  const profileInitial = $derived(
    (profileStore.nickname || nameValue || "?").charAt(0).toUpperCase()
  );
  const effectStyle = $derived(
    nameEffectStyle(
      nameEffect,
      colorValue,
      gradient2Value,
      gradient3Value ?? undefined
    )
  );

  // Closing the dialog or switching tabs mid-edit unmounts this component;
  // whatever was being typed must be saved, not thrown away.
  onDestroy(() => {
    if (editing === "name") void commitName();
    else if (editing === "tag") void commitTag();
    else if (editing === "bio") void commitBio();
  });

  function focusOnMount(el: HTMLElement) {
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }

  async function commitName() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== profileStore.nickname) await saveName(trimmed);
    editing = null;
  }

  async function commitTag() {
    // Snapshot before any await - belt to the effect-guard's suspenders.
    const trimmed = tagText.trim();
    const textColor = tagTextColor || undefined;
    const chipColor = tagChipColor || undefined;
    if (trimmed !== (profileStore.tagText ?? "")) {
      await saveTag(trimmed || undefined);
    }
    await saveTagColors(textColor, chipColor);
    editing = null;
  }

  async function commitBio() {
    if (bio !== (profileStore.bio ?? "")) await saveBio(bio || undefined);
    editing = null;
  }



  let copiedDid = $state(false);
  async function copyDid() {
    if (!identityStore.did) return;
    try {
      await navigator.clipboard.writeText(identityStore.did);
      copiedDid = true;
      setTimeout(() => (copiedDid = false), 1200);
    } catch {
      // Clipboard blocked: the did is visible to select by hand.
    }
  }
</script>

<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Profile</Label
    >
  </div>
  <p class="text-xs font-mono text-muted-foreground -mt-2">
    This card is what others see. Click any part of it to change it.
  </p>

  <div class="rounded-lg border border-border/50 bg-card overflow-hidden">
    <!-- Banner: click to change -->
    <button
      type="button"
      onclick={() => (bannerPickerOpen = true)}
      aria-label="Change banner"
      class="group relative block h-24 w-full cursor-pointer overflow-hidden bg-linear-to-r from-primary/20 to-secondary/40"
    >
      {#if profileStore.bannerUrl}
        <img
          src={profileStore.bannerUrl}
          alt="Profile banner"
          class="h-full w-full object-cover"
        />
      {/if}
      <div
        class="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/50 font-mono text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
      >
        <Camera class="size-4" />
        {profileStore.bannerUrl ? "Change banner" : "Add a banner"}
      </div>
    </button>
    {#if profileStore.bannerUrl}
      <div class="relative">
        <button
          type="button"
          onclick={() => saveBanner(undefined)}
          aria-label="Remove banner"
          class="absolute -top-22 right-2 z-10 flex size-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-red-500/80 transition-colors cursor-pointer"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
    {/if}

    <div class="flex flex-col gap-2 p-3">
      <!-- Avatar overlapping the banner: click opens the existing picker -->
      <button
        type="button"
        onclick={() => onAvatarClick?.()}
        aria-label="Change avatar"
        class="group relative -mt-11 flex size-16 items-center justify-center overflow-hidden rounded-full bg-primary/20 ring-4 ring-card cursor-pointer shrink-0"
      >
        {#if profileStore.avatarUrl}
          <img
            src={profileStore.avatarUrl}
            alt="Avatar"
            class="size-full object-cover"
          />
        {:else}
          <span class="font-mono text-lg font-semibold text-primary select-none"
            >{profileInitial}</span
          >
        {/if}
        <div
          class="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Pencil class="size-4 text-white" />
        </div>
      </button>

      <!-- Name + tag row -->
      {#if editing === "name"}
        <!-- Commit when focus leaves the whole EDITOR, pills and gradient
             stops included: with the handler on just the name row, pressing
             an effect pill blurred the input, committed, and unmounted the
             editor before mouseup - the pick never landed. display:contents
             keeps the layout while giving focusout one shared boundary. -->
        <div
          class="contents"
          onfocusout={(e) => {
            const editor = e.currentTarget as HTMLElement;
            if (!editor.contains(e.relatedTarget as Node)) commitName();
          }}
        >
        <div class="flex flex-wrap items-center gap-2">
          <input
            use:focusOnMount
            bind:value={nameValue}
            onkeydown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                nameValue = profileStore.nickname;
                editing = null;
              }
            }}
            placeholder="Your display name"
            class="w-40 rounded border border-border bg-background px-2 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <input
            type="color"
            bind:value={colorValue}
            onchange={() => saveColor(colorValue).catch(() => {})}
            aria-label="Nickname color"
            class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
        </div>
        <!-- Each pill previews its own effect on its label - what you pick
             is what you get, no dropdown guessing. -->
        <div class="flex flex-wrap items-center gap-1.5">
          {#each EFFECTS as fx (fx)}
            {@const pillStyle = nameEffectStyle(fx, colorValue, gradient2Value, gradient3Value ?? undefined)}
            <button
              type="button"
              onclick={() => pickEffect(fx)}
              class="cursor-pointer rounded-full border px-2.5 py-1 font-mono text-xs capitalize transition-colors {nameEffect === fx
                ? 'border-primary bg-primary/10'
                : 'border-border hover:border-primary/40'}"
            >
              <span class={pillStyle.class} style={pillStyle.style}>{fx}</span>
            </button>
          {/each}
        </div>
        {#if nameEffect === "gradient"}
          <div class="flex items-center gap-2">
            <span class="font-mono text-[10px] uppercase text-muted-foreground"
              >Stops</span
            >
            <input
              type="color"
              bind:value={colorValue}
              onchange={() => saveColor(colorValue).catch(() => {})}
              aria-label="Gradient start (nickname color)"
              class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            <input
              type="color"
              bind:value={gradient2Value}
              onchange={commitGradients}
              aria-label="Second gradient color"
              class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            {#if gradient3Value !== null}
              <input
                type="color"
                bind:value={gradient3Value}
                onchange={commitGradients}
                aria-label="Third gradient color"
                class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
              />
              <button
                type="button"
                onclick={() => {
                  gradient3Value = null;
                  commitGradients();
                }}
                aria-label="Remove third color"
                class="cursor-pointer font-mono text-xs text-muted-foreground hover:text-destructive"
                >x</button
              >
            {:else}
              <button
                type="button"
                onclick={() => {
                  gradient3Value = "#22d3ee";
                  commitGradients();
                }}
                aria-label="Add a third color"
                class="cursor-pointer rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/60 hover:text-foreground"
                >+ color</button
              >
            {/if}
          </div>
        {/if}
        </div>
      {:else}
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onclick={() => (editing = "name")}
            aria-label="Edit name, color and effect"
            class="group flex cursor-pointer items-center gap-1.5"
          >
            <span
              class="font-mono text-base font-semibold {effectStyle.class}"
              style={effectStyle.style ||
                (profileStore.color ? `color: ${profileStore.color}` : "")}
            >
              {profileStore.nickname || "Anonymous"}
            </span>
            <Pencil
              class="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>

          {#if editing !== "tag"}
            {#if profileStore.tagText}
              <button
                type="button"
                onclick={() => (editing = "tag")}
                aria-label="Edit tag"
                class="cursor-pointer rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase hover:opacity-80"
                style={`background-color: ${profileStore.tagChipColor ?? "#e5e7eb"}; color: ${profileStore.tagTextColor ?? "#000000"}`}
              >
                {profileStore.tagText}
              </button>
            {:else}
              <button
                type="button"
                onclick={() => (editing = "tag")}
                aria-label="Add a tag"
                class="flex cursor-pointer items-center gap-0.5 rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors"
              >
                <Plus class="size-3" /> tag
              </button>
            {/if}
          {/if}
        </div>
      {/if}

      {#if editing === "tag"}
        <!-- Same rule as the name row: clicking away SAVES. Enter-or-the-
             check-button-only silently discarded a typed tag on blur. -->
        <div
          class="flex flex-wrap items-center gap-2"
          onfocusout={(e) => {
            const row = e.currentTarget as HTMLElement;
            if (!row.contains(e.relatedTarget as Node)) commitTag();
          }}
        >
          <input
            use:focusOnMount
            bind:value={tagText}
            maxlength="5"
            placeholder="2-5 ch"
            onkeydown={(e) => {
              if (e.key === "Enter") commitTag();
              if (e.key === "Escape") {
                tagText = profileStore.tagText ?? "";
                editing = null;
              }
            }}
            class="w-20 rounded border border-border bg-background px-2 py-1 text-center font-mono text-xs uppercase focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <input
            type="color"
            bind:value={tagTextColor}
            aria-label="Tag text color"
            title="Text"
            class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <input
            type="color"
            bind:value={tagChipColor}
            aria-label="Tag chip color"
            title="Chip"
            class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <span
            class="rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase"
            style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
          >
            {tagText || "TAG"}
          </span>
          <button
            type="button"
            onclick={commitTag}
            aria-label="Save tag"
            class="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <Check class="size-4" />
          </button>
          {#if profileStore.tagText}
            <button
              type="button"
              onclick={async () => {
                tagText = "";
                await saveTag(undefined);
                editing = null;
              }}
              aria-label="Remove tag"
              class="cursor-pointer text-muted-foreground hover:text-destructive"
            >
              <Trash2 class="size-3.5" />
            </button>
          {/if}
        </div>
      {/if}

      <!-- Bio: click to edit -->
      {#if editing === "bio"}
        <div class="flex flex-col gap-1">
          <textarea
            use:focusOnMount
            bind:value={bio}
            onblur={commitBio}
            onkeydown={(e) => {
              if (e.key === "Escape") {
                bio = profileStore.bio ?? "";
                editing = null;
              }
            }}
            maxlength="200"
            placeholder="Tell people something..."
            class="h-20 resize-none rounded border border-border bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          ></textarea>
          <span class="text-right font-mono text-[10px] text-muted-foreground"
            >{bio.length}/200</span
          >
        </div>
      {:else}
        <button
          type="button"
          onclick={() => (editing = "bio")}
          aria-label="Edit bio"
          class="group block min-h-20 w-full cursor-pointer rounded text-left"
        >
          {#if profileStore.bio}
            <span
              class="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground group-hover:text-foreground transition-colors"
              >{profileStore.bio}</span
            >
          {:else}
            <span
              class="font-mono text-xs text-muted-foreground/60 italic group-hover:text-muted-foreground transition-colors"
              >Add a bio...</span
            >
          {/if}
        </button>
      {/if}

      <!-- DID -->
      {#if identityStore.did}
        <div
          class="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5"
        >
          <span
            class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            >{identityStore.did}</span
          >
          <button
            type="button"
            onclick={copyDid}
            aria-label="Copy DID"
            class="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
          >
            {#if copiedDid}
              <Check class="size-3.5 text-primary" />
            {:else}
              <Copy class="size-3.5" />
            {/if}
          </button>
        </div>
      {/if}
    </div>
  </div>

  <AvatarPickerDialog
    open={bannerPickerOpen}
    onClose={() => (bannerPickerOpen = false)}
    target="banner"
  />

  {#if isMobile}
    <Button
      variant="outline"
      class="w-full font-mono text-muted-foreground"
      onclick={() => lock()}
    >
      <LogOut class="w-4 h-4 mr-2" />
      Lock/Logout
    </Button>
  {/if}
</div>
