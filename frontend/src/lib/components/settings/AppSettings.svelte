<script lang="ts">
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import {
  notifyState,
  setMessageSoundsEnabled,
  setNotificationsEnabled,
} from "$lib/notify.svelte";
import { mediaPrefs, setGifAutoplay } from "$lib/media-prefs.svelte";
</script>

<!-- Notifications Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-violet-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Notifications</Label
    >
  </div>
  {#if notifyState.supported}
    <div class="flex items-center justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-xs font-mono">Notify me about new messages</span>
        <span class="text-xs font-mono text-muted-foreground leading-relaxed">
          Only while the app is running and off screen. Nothing can reach you
          once it is fully closed: no server is holding your messages.
        </span>
      </div>
      <Switch
        checked={notifyState.enabled}
        onCheckedChange={(checked) => setNotificationsEnabled(checked)}
      />
    </div>
    {#if notifyState.permission === "denied"}
      <p class="text-xs font-mono text-muted-foreground">
        Your browser is blocking notifications for this site. Allow them in the
        site permissions to turn this on.
      </p>
    {/if}
  {/if}
  <!-- Sounds need no notification permission, so they are not behind the
       supported gate. -->
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Message sounds</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        A soft tone for incoming messages. Stays quiet while you are reading
        that conversation with the window focused.
      </span>
    </div>
    <Switch
      checked={notifyState.soundsEnabled}
      onCheckedChange={(checked) => setMessageSoundsEnabled(checked)}
    />
  </div>
</div>

<!-- Appearance Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-amber-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Appearance</Label
    >
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Auto-play GIFs in chat</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        Off shows a still preview that plays while you hover it. Avatars in
        lists always wait for a hover, and in calls they play while that
        person is speaking.
      </span>
    </div>
    <Switch
      checked={mediaPrefs.gifAutoplay}
      onCheckedChange={(checked) => setGifAutoplay(checked)}
    />
  </div>
</div>
