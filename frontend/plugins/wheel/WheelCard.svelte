<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { HostApi } from "$lib/plugins/api";

  interface Props {
    card: Message;
    state: unknown;
    host: HostApi;
  }

  let { card, state, host }: Props = $props();

  const wheelState = state as {
    options: string[];
    spun: boolean;
    winner: number | null;
    spinnerName: string;
  };

  let spinning = $state(false);
  let rotation = $state(0);

  async function handleSpin() {
    if (spinning || wheelState.spun) return;
    spinning = true;

    try {
      // Parse the card payload
      const payload = JSON.parse(card.content) as Record<string, unknown>;
      const { data } = payload;

      // Animate the wheel
      let targetRotation = Math.random() * 360 * 5 + 360;
      const startTime = Date.now();
      const duration = 2000;

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        rotation = targetRotation * progress;

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      animate();

      // Send the spin update after a moment
      setTimeout(async () => {
        try {
          await host.sendUpdate(card.id, { action: "spin" });
        } catch (err) {
          console.error("[wheel] failed to send spin:", err);
        } finally {
          spinning = false;
        }
      }, duration);
    } catch (err) {
      console.error("[wheel] spin error:", err);
      spinning = false;
    }
  }
</script>

<div class="flex flex-col gap-4 max-w-sm">
  {#if wheelState.options.length === 0}
    <div class="text-xs text-muted-foreground">No options configured</div>
  {:else}
    <div class="flex flex-col items-center gap-4">
      <div
        class="w-48 h-48 rounded-full border-4 border-primary flex items-center justify-center relative overflow-hidden bg-gradient-to-r from-primary/20 to-primary/10"
        style="transform: rotate({rotation}deg);"
      >
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="text-sm font-mono text-center">
            {#if wheelState.spun && wheelState.winner !== null}
              <div class="text-primary font-bold">
                {wheelState.options[wheelState.winner]}
              </div>
            {:else}
              <div class="text-muted-foreground">Spin the wheel</div>
            {/if}
          </div>
        </div>
        <div
          class="absolute inset-0 pointer-events-none"
          style="background: conic-gradient({wheelState.options
            .map((_, i) => {
              const angle = (360 / wheelState.options.length) * i;
              const color =
                i % 2 === 0 ? 'rgba(59, 130, 246, 0.1)' : 'transparent';
              return `${color} ${angle}deg ${angle + 360 / wheelState.options.length}deg`;
            })
            .join(', ')})"
        />
      </div>

      {#if !wheelState.spun}
        <Button onclick={handleSpin} disabled={spinning}>
          {#if spinning}
            Spinning...
          {:else}
            Spin
          {/if}
        </Button>
      {:else}
        <div class="text-center">
          <div class="text-sm font-mono text-primary font-bold mb-1">
            Winner: {wheelState.options[wheelState.winner ?? 0]}
          </div>
          <div class="text-xs text-muted-foreground">
            Spun by {wheelState.spinnerName}
          </div>
        </div>
      {/if}
    </div>

    <div class="text-xs text-muted-foreground space-y-1">
      <div class="font-mono font-semibold mb-2">Options:</div>
      <div class="space-y-1">
        {#each wheelState.options as option, i (i)}
          <div
            class="px-2 py-1 rounded bg-muted/50 {wheelState.spun &&
            wheelState.winner === i
              ? 'ring-1 ring-primary'
              : ''}"
          >
            {option}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
