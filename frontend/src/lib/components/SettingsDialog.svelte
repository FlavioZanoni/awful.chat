<script lang="ts">
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";
  import { viewportHeight } from "$lib/actions/viewport-height";
  import { Button } from "$lib/components/ui/button";
  import { lock } from "$lib/identity/identity.svelte";
  import {
    LogOut,
    SlidersHorizontal,
    User,
    Volume2,
    RefreshCw,
    ChartPie,
    Info,
    Heart,
  } from "@lucide/svelte";

  import ProfileSettings from "./settings/ProfileSettings.svelte";
  import AudioSettings from "./settings/AudioSettings.svelte";
  import SessionSettings from "./settings/SessionSettings.svelte";
  import AppSettings from "./settings/AppSettings.svelte";
  import DataSettings from "./settings/DataSettings.svelte";
  import AvatarPickerDialog from "./AvatarPickerDialog.svelte";
  import QuirksNotice from "./QuirksNotice.svelte";
  import OssCredits from "./OssCredits.svelte";

  type SettingsTab =
    | "profile"
    | "audio"
    | "app"
    | "session"
    | "data"
    | "quirks"
    | "oss";

  interface Props {
    open: boolean;
    onClose: () => void;
    onOpenSync?: (mode: "generate-qr" | "scan-qr") => void;
  }

  let { open = $bindable(), onClose, onOpenSync }: Props = $props();

  let activeTab = $state<SettingsTab>("profile");
  let avatarDialogOpen = $state(false);
  let isMobile = $state(false);

  const tabs = $state([
    { id: "profile" as SettingsTab, label: "Profile", icon: User },
    { id: "audio" as SettingsTab, label: "Audio", icon: Volume2 },
    { id: "app" as SettingsTab, label: "App", icon: SlidersHorizontal },
    { id: "session" as SettingsTab, label: "Session/Sync", icon: RefreshCw },
    { id: "data" as SettingsTab, label: "Data", icon: ChartPie },
    { id: "quirks" as SettingsTab, label: "Quirks", icon: Info },
    { id: "oss" as SettingsTab, label: "OSS", icon: Heart },
  ]);

  $effect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => {
      isMobile = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });

  function handleLockLogout() {
    lock();
  }

  const closeHandler = (v: boolean) => {
    if (!v) onClose();
  };
</script>

{#snippet TabBar()}
  <div
    class="flex flex-row sm:flex-col gap-1 p-1 bg-muted rounded-lg md:h-full"
  >
    {#each tabs as tab}
      <button
        type="button"
        onclick={() => (activeTab = tab.id)}
        class="flex-1 sm:flex-none flex items-center justify-center sm:justify-start gap-2 px-3 py-2 rounded-md text-xs font-mono transition-colors whitespace-nowrap {activeTab ===
        tab.id
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10'}"
      >
        <!-- shrink-0: without it a long label like "Session/Sync" squeezes its
             own icon narrower than the others, so the labels no longer start
             at the same x and the column looks ragged. -->
        <tab.icon class="w-4 h-4 shrink-0" />
        <span class="hidden sm:inline truncate">{tab.label}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet QuirksTab()}
  <div class="flex flex-col gap-3">
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      Awful.chat is peer to peer: no accounts on a server, no copy of your data
      anywhere but your own devices. Here is what that changes compared to apps
      like WhatsApp or Discord.
    </p>
    <QuirksNotice />
  </div>
{/snippet}

{#snippet OssTab()}
  <div class="flex flex-col gap-3">
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      Awful.chat is built entirely on open source. These are the projects doing
      the heavy lifting, and they deserve the credit.
    </p>
    <OssCredits />
  </div>
{/snippet}

{#snippet DesktopSidebar()}
  <div class="flex flex-col h-full">
    <div class="flex-1">
      {@render TabBar()}
    </div>
    <div class="pt-2 border-t border-border mt-2">
      <Button
        variant="ghost"
        class="w-full font-mono text-xs text-muted-foreground justify-start
          hover:bg-destructive/10! hover:text-destructive!"
        onclick={handleLockLogout}
      >
        <LogOut class="w-4 h-4 mr-2" />
        Lock / Logout
      </Button>
    </div>
  </div>
{/snippet}

{#snippet DesktopContent()}
  <div class="flex flex-row h-full gap-8">
    <div class="hidden sm:flex w-36 h-full">
      {@render DesktopSidebar()}
    </div>
    <div class="flex-1 overflow-y-auto pr-2 pt-4">
      {#if activeTab === "profile"}
        <ProfileSettings
          {isMobile}
          {avatarDialogOpen}
          onAvatarClick={() => (avatarDialogOpen = true)}
        />
      {:else if activeTab === "audio"}
        <AudioSettings />
      {:else if activeTab === "app"}
        <AppSettings />
      {:else if activeTab === "session"}
        <SessionSettings {isMobile} {onClose} {onOpenSync} />
      {:else if activeTab === "data"}
        <DataSettings {activeTab} />
      {:else if activeTab === "quirks"}
        {@render QuirksTab()}
      {:else if activeTab === "oss"}
        {@render OssTab()}
      {/if}
    </div>
  </div>
{/snippet}

{#if isMobile}
  <Drawer bind:open onOpenChange={closeHandler} direction="bottom">
    <DrawerContent class="bg-card text-card-foreground border-border">
      <DrawerHeader class="px-4 py-2 bg-card sticky">
        <DrawerTitle class="font-mono text-base font-semibold mx-auto"
          >Settings</DrawerTitle
        >
        {@render TabBar()}
      </DrawerHeader>
      <div use:viewportHeight class="flex flex-col w-full overflow-hidden">
        <div class="px-4 py-2 space-y-4 overflow-y-auto min-h-0">
          {#if activeTab === "profile"}
            <ProfileSettings
              {isMobile}
              {avatarDialogOpen}
              onAvatarClick={() => (avatarDialogOpen = true)}
            />
          {:else if activeTab === "audio"}
            <AudioSettings />
          {:else if activeTab === "app"}
            <AppSettings />
          {:else if activeTab === "session"}
            <SessionSettings {isMobile} {onClose} {onOpenSync} />
          {:else if activeTab === "data"}
            <DataSettings {activeTab} />
          {:else if activeTab === "quirks"}
            {@render QuirksTab()}
          {:else if activeTab === "oss"}
            {@render OssTab()}
          {/if}
        </div>
      </div>
    </DrawerContent>
  </Drawer>
{:else}
  <Dialog bind:open onOpenChange={closeHandler}>
    <DialogContent
      class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-lg lg:max-w-5xl min-h-200 sm:h-137.5 lg:h-150 flex flex-col p-0"
    >
      <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
        <DialogTitle class="font-mono text-base font-semibold"
          >Settings</DialogTitle
        >
      </DialogHeader>
      <div class="flex-1 overflow-hidden px-4 pb-4">
        {@render DesktopContent()}
      </div>
    </DialogContent>
  </Dialog>
{/if}

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
