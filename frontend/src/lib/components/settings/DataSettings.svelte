<script lang="ts">
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import {
    wipeLocalDatabase,
    getStorageMetrics,
    type StorageMetrics,
  } from "$lib/storage";
  import {
    HardDrive,
    File,
    MessageSquare,
    Users,
    Database,
    Download,
    Upload,
  } from "@lucide/svelte";
  import {
    downloadBackup,
    readBackupFile,
    applyBackup,
    summarizeBackup,
    type BackupFile,
    type BackupSummary,
  } from "$lib/transport/sync.svelte";

  interface Props {
    activeTab?: string;
  }

  let { activeTab = "data" }: Props = $props();

  let metrics = $state<StorageMetrics | null>(null);
  let confirmErase = $state(false);

  $effect(() => {
    if (activeTab === "data" && !metrics) {
      getStorageMetrics()
        .then((m) => {
          metrics = m;
        })
        .catch(() => {
          metrics = null;
        });
    }
  });

  function formatBytes(bytes: number | undefined): string {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(k)),
      sizes.length - 1
    );
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  async function handleEraseLocalData() {
    await wipeLocalDatabase();
    window.location.reload();
  }

  // ── Backup / restore ──────────────────────────────────────────────────────
  let fileInput = $state<HTMLInputElement | null>(null);
  let backupBusy = $state(false);
  let backupError = $state<string | null>(null);
  // The parsed backup is deliberately NOT $state: a rune proxy cannot be
  // structured-cloned, so handing it to IndexedDB throws and the import
  // silently does nothing. Only the summary needs to be reactive.
  let pendingBackup: BackupFile | null = null;
  let pendingSummary = $state<BackupSummary | null>(null);

  async function handleDownload() {
    backupError = null;
    backupBusy = true;
    try {
      await downloadBackup();
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
    } finally {
      backupBusy = false;
    }
  }

  async function handleFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // let the same file be picked again after a cancel
    if (!file) return;
    backupError = null;
    backupBusy = true;
    try {
      const data = await readBackupFile(file);
      pendingBackup = data;
      pendingSummary = summarizeBackup(data);
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
    } finally {
      backupBusy = false;
    }
  }

  async function handleApply(mode: "add" | "replace") {
    if (!pendingBackup) return;
    backupError = null;
    backupBusy = true;
    try {
      await applyBackup(pendingBackup, mode);
      window.location.reload();
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
      backupBusy = false;
    }
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Storage Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-orange-500 rounded-full"></div>
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Storage</Label
      >
    </div>

    {#if metrics}
      <div class="flex flex-col gap-4">
        <!-- Stats Grid -->
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <MessageSquare class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Messages</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalMessages.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <Users class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Rooms</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalRooms.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <Users class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Profiles</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalProfiles.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <File class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Files</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalAttachments.toLocaleString()}
            </p>
          </div>
        </div>

        <!-- Storage Size Card -->
        <div class="bg-muted/50 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <HardDrive class="w-4 h-4 text-muted-foreground" />
              <span class="text-xs text-muted-foreground font-mono uppercase"
                >Total Storage</span
              >
            </div>
            <span class="text-lg font-semibold font-mono"
              >{formatBytes(metrics.storedDataSize)}</span
            >
          </div>

          {#if metrics.totalAttachments > 0}
            <div class="space-y-2">
              <div class="flex items-center justify-between text-xs">
                <span class="text-muted-foreground font-mono">
                  Seeding {metrics.seedingAttachments} of {metrics.totalAttachments}
                  files
                </span>
                <span class="font-mono text-green-500">
                  {Math.round(
                    (metrics.seedingAttachments / metrics.totalAttachments) *
                      100
                  )}%
                </span>
              </div>
              <div class="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  class="h-full bg-linear-to-r from-green-500 to-green-400 rounded-full transition-all duration-500"
                  style="width: {(metrics.seedingAttachments /
                    metrics.totalAttachments) *
                    100}%"
                ></div>
              </div>
            </div>
          {:else}
            <p class="text-xs text-muted-foreground font-mono">
              No attachments stored
            </p>
          {/if}
        </div>

        <!-- Top Rooms Bar Chart -->
        {#if metrics.rooms.length > 0}
          <div class="bg-muted/50 rounded-lg p-4">
            <div class="flex items-center gap-2 mb-3">
              <Database class="w-4 h-4 text-muted-foreground" />
              <span class="text-xs text-muted-foreground font-mono uppercase"
                >Top Rooms</span
              >
            </div>
            <div class="flex flex-col gap-2">
              {#each metrics.rooms as room, i}
                {@const maxMessages = metrics.rooms[0]?.messageCount || 1}
                <div class="flex items-center gap-2 text-xs">
                  <span class="font-mono w-4 text-muted-foreground"
                    >{i + 1}.</span
                  >
                  <span class="font-mono w-24 truncate text-muted-foreground"
                    >{room.name}</span
                  >
                  <div class="flex-1 h-2 bg-muted rounded overflow-hidden">
                    <div
                      class="h-full bg-primary/60 rounded transition-all duration-500"
                      style="width: {(room.messageCount / maxMessages) * 100}%"
                    ></div>
                  </div>
                  <span class="font-mono w-10 text-right"
                    >{room.messageCount}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex items-center justify-center py-8">
        <div class="flex flex-col items-center gap-2">
          <Database class="w-8 h-8 text-muted-foreground animate-pulse" />
          <span class="text-xs text-muted-foreground font-mono"
            >Loading metrics...</span
          >
        </div>
      </div>
    {/if}
  </div>

  <!-- Backup / Restore -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-cyan-500 rounded-full"></div>
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Backup</Label
      >
    </div>
    <p class="text-xs text-muted-foreground font-mono leading-relaxed">
      Save everything on this device to a file, or restore from one. Same data
      as a QR device sync, without needing both devices online at once. The file
      contains your encrypted identity: anyone who has it and your password has
      your account, so keep it somewhere safe.
    </p>

    {#if backupError}
      <p
        class="text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2"
      >
        {backupError}
      </p>
    {/if}

    {#if pendingSummary}
      {@const s = pendingSummary}
      <div class="flex flex-col gap-3 bg-muted/50 rounded-lg p-3">
        <p class="text-xs font-mono text-muted-foreground">
          {s.messages.toLocaleString()} messages · {s.rooms} rooms · {s.attachments}
          files · {s.profiles} profiles{s.exportedAt
            ? ` · from ${new Date(s.exportedAt).toLocaleDateString()}`
            : ""}
        </p>
        <p class="text-xs font-mono text-muted-foreground">
          {s.hasIdentity
            ? "Includes an identity, so it can replace this device entirely."
            : "No identity in this file, so it can only be merged."}
        </p>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            class="flex-1 font-mono text-xs"
            disabled={backupBusy}
            onclick={() => handleApply("add")}
          >
            Merge into this device
          </Button>
          <Button
            variant="destructive"
            class="flex-1 font-mono text-xs"
            disabled={backupBusy || !s.hasIdentity}
            onclick={() => handleApply("replace")}
          >
            Replace everything
          </Button>
        </div>
        <Button
          variant="ghost"
          class="font-mono text-xs text-muted-foreground"
          disabled={backupBusy}
          onclick={() => {
            pendingBackup = null;
            pendingSummary = null;
          }}
        >
          Cancel
        </Button>
      </div>
    {:else}
      <div class="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          disabled={backupBusy}
          onclick={handleDownload}
        >
          <Download class="w-3.5 h-3.5 mr-2" />
          Download my data
        </Button>
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          disabled={backupBusy}
          onclick={() => fileInput?.click()}
        >
          <Upload class="w-3.5 h-3.5 mr-2" />
          Restore from file
        </Button>
      </div>
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept="application/json,.json"
      class="hidden"
      onchange={handleFilePicked}
    />
  </div>

  <!-- Danger Zone -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-red-500 rounded-full"></div>
      <Label class="text-xs font-mono text-destructive uppercase tracking-wider"
        >Danger Zone</Label
      >
    </div>
    <p class="text-xs text-muted-foreground font-mono">
      Erase all local data including identity, messages, and media.
    </p>
    {#if !confirmErase}
      <Button
        variant="destructive"
        class="w-full font-mono text-xs"
        onclick={() => (confirmErase = true)}
      >
        Erase all data
      </Button>
    {:else}
      <div class="flex gap-2">
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          onclick={() => (confirmErase = false)}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          class="flex-1 font-mono text-xs"
          onclick={handleEraseLocalData}
        >
          Confirm
        </Button>
      </div>
    {/if}
  </div>
</div>
