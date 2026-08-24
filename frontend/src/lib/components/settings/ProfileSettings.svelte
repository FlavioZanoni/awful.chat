<script lang="ts">
  import { Input } from "$lib/components/ui/input";
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
  } from "$lib/profile.svelte";
  import { lock } from "$lib/identity/identity.svelte";
  import { nameEffectStyle } from "$lib/name-effect";
  import { Pencil, LogOut, Trash2 } from "@lucide/svelte";

  interface Props {
    isMobile?: boolean;
    avatarDialogOpen?: boolean;
    onAvatarClick?: () => void;
  }

  let { isMobile = false, onAvatarClick }: Props = $props();

  let nameValue = $state("");
  let colorValue = $state("#3b82f6");
  let bannerUrl = $state("");
  let tagText = $state("");
  let tagTextColor = $state("#000000");
  let tagChipColor = $state("#e5e7eb");
  let bio = $state("");
  let nameEffect = $state("none");

  $effect(() => {
    nameValue = profileStore.nickname;
    colorValue = profileStore.color ?? "#3b82f6";
    bannerUrl = profileStore.bannerUrl ?? "";
    tagText = profileStore.tagText ?? "";
    tagTextColor = profileStore.tagTextColor ?? "#000000";
    tagChipColor = profileStore.tagChipColor ?? "#e5e7eb";
    bio = profileStore.bio ?? "";
    nameEffect = profileStore.nameEffect ?? "none";
  });

  const profileInitial = $derived(
    (profileStore.nickname || nameValue || "?").charAt(0).toUpperCase()
  );

  const previewEffectStyle = $derived(nameEffectStyle(nameEffect, colorValue));

  async function handleNameBlur() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== profileStore.nickname) {
      await saveName(trimmed);
    }
  }

  async function handleBannerChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > 1_000_000) {
      alert("Banner must be under 1 MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const result = reader.result;
      if (typeof result === "string") {
        await saveBanner(result);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleTagBlur() {
    const trimmed = tagText.trim();
    if (trimmed !== profileStore.tagText) {
      await saveTag(trimmed || undefined);
    }
  }

  async function handleTagColorsChange() {
    await saveTagColors(
      tagTextColor || undefined,
      tagChipColor || undefined
    );
  }

  async function handleBioBlur() {
    if (bio !== profileStore.bio) {
      await saveBio(bio || undefined);
    }
  }

  async function handleNameEffectChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    if (value !== profileStore.nameEffect) {
      await saveNameEffect(value || undefined);
    }
  }

  function handleLockLogout() {
    lock();
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

  <!-- Live Preview -->
  <div class="flex flex-col gap-2 p-3 bg-card rounded-lg border border-border/30">
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Live preview</Label
    >
    <div class="flex flex-col gap-2">
      {#if bannerUrl}
        <div
          class="w-full h-16 rounded-lg overflow-hidden bg-muted/30"
        >
          <img
            src={bannerUrl}
            alt="Banner preview"
            class="w-full h-full object-cover"
          />
        </div>
      {/if}
      <div class="flex flex-col items-center gap-2">
        <div
          class="flex size-16 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border shrink-0"
        >
          {#if profileStore.avatarUrl}
            <img
              src={profileStore.avatarUrl}
              alt="Avatar"
              class="size-full object-cover"
            />
          {:else}
            <span
              class="text-lg font-semibold text-primary font-mono select-none"
            >
              {profileInitial}
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <span
            class="text-sm font-mono font-semibold"
            class:name-effect-gradient={previewEffectStyle.class.includes("gradient")}
            class:name-effect-shimmer={previewEffectStyle.class.includes("shimmer")}
            class:name-effect-glow={previewEffectStyle.class.includes("glow")}
            class:name-effect-rainbow={previewEffectStyle.class.includes("rainbow")}
            style={previewEffectStyle.style || (colorValue ? `color: ${colorValue}` : "")}
          >
            {nameValue || "Anonymous"}
          </span>
          {#if tagText}
            <div
              class="px-2 py-0.5 rounded text-xs font-mono font-semibold"
              style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
            >
              {tagText}
            </div>
          {/if}
        </div>
        {#if bio}
          <div class="text-xs text-muted-foreground text-center whitespace-pre-wrap max-w-[200px] break-words">
            {bio}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Edit Sections -->
  <div class="flex flex-col gap-3">
    <!-- Avatar and Name -->
    <div class="flex flex-col items-center gap-3">
      <button
        type="button"
        onclick={() => onAvatarClick?.()}
        aria-label="Change avatar"
        class="relative group flex size-20 md:size-36 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border hover:ring-primary/60 transition-all cursor-pointer shrink-0"
      >
        {#if profileStore.avatarUrl}
          <img
            src={profileStore.avatarUrl}
            alt="Avatar"
            class="size-full object-cover"
          />
        {:else}
          <span
            class="text-2xl font-semibold text-primary font-mono select-none"
            >{profileInitial}</span
          >
        {/if}
        <div
          class="absolute inset-0 rounded-full flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil class="text-white" />
        </div>
      </button>
      <Input
        bind:value={nameValue}
        onblur={handleNameBlur}
        onkeydown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="Your display name"
        class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring text-center w-full max-w-64 md:max-w-80"
      />

      <!-- Nickname Color -->
      <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Nickname color</Label
        >
        <div class="flex items-center gap-2">
          <input
            type="color"
            bind:value={colorValue}
            onchange={() => saveColor(colorValue).catch(() => {})}
            aria-label="Nickname color"
            class="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <span
            class="flex-1 truncate text-sm font-medium font-mono"
            style={colorValue
              ? `color: ${colorValue}`
              : ""}
            >{nameValue || "Anonymous"}</span
          >
          <button
            type="button"
            onclick={() => {
              colorValue = "#3b82f6";
              saveColor(null).catch(() => {});
            }}
            aria-label="Reset nickname color to default"
            class="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Reset
          </button>
        </div>
      </div>

      <!-- Name Effect -->
      <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Name effect</Label
        >
        <select
          bind:value={nameEffect}
          onchange={handleNameEffectChange}
          class="px-3 py-2 rounded border border-border bg-background text-foreground font-mono text-sm"
        >
          <option value="none">None</option>
          <option value="gradient">Gradient</option>
          <option value="shimmer">Shimmer</option>
          <option value="glow">Glow</option>
          <option value="rainbow">Rainbow</option>
        </select>
      </div>
    </div>

    <!-- Banner -->
    <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80 mx-auto">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Banner</Label
      >
      <div class="flex items-center gap-2">
        <input
          type="file"
          accept="image/*"
          onchange={handleBannerChange}
          aria-label="Banner image"
          class="text-xs"
        />
        {#if bannerUrl}
          <button
            type="button"
            onclick={async () => {
              await saveBanner(undefined);
            }}
            aria-label="Remove banner"
            class="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        {/if}
      </div>
    </div>

    <!-- Tag -->
    <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80 mx-auto">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Profile tag (2-5 chars)</Label
      >
      <Input
        bind:value={tagText}
        onblur={handleTagBlur}
        onkeydown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="e.g. ADMIN"
        maxlength="5"
        class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring text-center"
      />
    </div>

    <!-- Tag Colors -->
    {#if tagText}
      <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80 mx-auto">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Tag colors</Label
        >
        <div class="flex items-center gap-2">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-muted-foreground">Text</label>
            <input
              type="color"
              bind:value={tagTextColor}
              onchange={handleTagColorsChange}
              aria-label="Tag text color"
              class="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-muted-foreground">Background</label>
            <input
              type="color"
              bind:value={tagChipColor}
              onchange={handleTagColorsChange}
              aria-label="Tag chip color"
              class="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
          </div>
          <div
            class="px-2 py-1 rounded text-xs font-mono font-semibold"
            style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
          >
            {tagText}
          </div>
        </div>
      </div>
    {/if}

    <!-- Bio -->
    <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80 mx-auto">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Bio (max 200 chars)</Label
      >
      <textarea
        bind:value={bio}
        onblur={handleBioBlur}
        placeholder="Tell us about yourself..."
        maxlength="200"
        class="px-3 py-2 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground font-mono text-sm resize-none h-20"
      ></textarea>
      <div class="text-xs text-muted-foreground">
        {bio.length}/200
      </div>
    </div>
  </div>

  {#if isMobile}
    <Button
      variant="outline"
      class="w-full font-mono text-muted-foreground"
      onclick={handleLockLogout}
    >
      <LogOut class="w-4 h-4 mr-2" />
      Lock/Logout
    </Button>
  {/if}
</div>

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
