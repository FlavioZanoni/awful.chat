<script lang="ts">
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { getRegistry } from "$lib/plugins/registry";
  import { pluginPrefs, togglePlugin } from "$lib/plugins/prefs.svelte";

  const registry = getRegistry();
</script>

<div class="flex flex-col gap-6">
  {#if registry.size === 0}
    <div
      class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
    >
      <p class="text-xs font-mono text-muted-foreground">
        No plugins installed on this instance.
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-4">
      {#each Array.from(registry.entries()) as [pluginId, registered] (pluginId)}
        <div
          class="flex items-center justify-between gap-3 p-4 bg-muted/30 rounded-lg border border-border/50"
        >
          <div class="flex items-center gap-3 min-w-0">
            <span class="text-lg"><PluginIcon icon={registered.manifest.icon} class="size-5" /></span>
            <div class="min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-mono font-semibold"
                  >{registered.manifest.name}</span
                >
                <span class="text-xs font-mono text-muted-foreground"
                  >v{registered.manifest.apiVersion}</span
                >
              </div>
              <p class="text-xs font-mono text-muted-foreground truncate">
                {registered.manifest.description}
              </p>
              {#if registered.manifest.author || registered.manifest.license}
                <p class="text-[10px] font-mono text-muted-foreground/70">
                  {[registered.manifest.author, registered.manifest.license]
                    .filter(Boolean)
                    .join(" - ")}
                </p>
              {/if}
            </div>
          </div>
          <Switch
            checked={!pluginPrefs.disabledPluginIds.includes(pluginId)}
            onCheckedChange={(checked) => togglePlugin(pluginId, checked)}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>
