<script lang="ts">
  import { useRegisterSW } from "virtual:pwa-register/svelte";
  import { X } from "@lucide/svelte";

  const { needRefresh, updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(swUrl, registration) {
      console.log(`Service Worker at: ${swUrl}`);
      // A long-lived PWA tab only checks for updates on navigation, which a
      // PWA never does - without this poll an update went unseen until the
      // next full reload, days later.
      if (registration) {
        setInterval(() => void registration.update(), 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.log("SW registration error", error);
    },
  });

  function close() {
    needRefresh.set(false);
  }
</script>

{#if $needRefresh}
  <div
    class="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border bg-background/95 backdrop-blur px-4 py-3 text-sm font-mono text-foreground shadow-lg"
    role="alert"
  >
    <span>New version available</span>
    <button
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
      onclick={() => updateServiceWorker()}
    >
      Reload
    </button>
    <button
      class="text-muted-foreground hover:text-foreground cursor-pointer"
      onclick={close}
      aria-label="Close"
    >
      <X size={16} />
    </button>
  </div>
{/if}
