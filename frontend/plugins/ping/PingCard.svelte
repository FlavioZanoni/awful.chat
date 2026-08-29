<script lang="ts">
  /**
   * A live round-trip graph, drawn while it measures.
   *
   * Only the person who ran the command probes. Round trips are
   * point-to-point, so their numbers are theirs - a viewer's link to the
   * same peer is a different link. Publishing every sample would be sixty
   * messages per peer, so the run is local and one update carries the
   * summary at the end.
   */
  import { onDestroy, onMount } from "svelte";
  import type { HostApi } from "$lib/plugins/api";
  import {
    BASE_INTERVAL_MS,
    chartCeiling,
    nextInterval,
    PROBE_TIMEOUT_MS,
    summarize,
    WINDOW_MS,
    type Sample,
    type Stats,
  } from "./logic";
  import type { PingState } from "./index";

  // cardState, not state. That is the name the host passes - so a prop
  // called `state` was simply never populated - and it would have shadowed
  // the $state rune used all through this component.
  let {
    card,
    cardState,
    host,
  }: { card: { id: string }; cardState: PingState; host: HostApi } = $props();

  /** One line each, in the order they were named. */
  const COLORS = ["#22c55e", "#38bdf8", "#f472b6"];

  const isOwner = $derived(cardState.ownerDid === host.selfDid());
  const done = $derived(Object.keys(cardState.results).length > 0);

  let samples = $state<Record<string, Sample[]>>({});
  /**
   * Display only. The effect below WRITES this and must never read it: an
   * effect that reads a piece of state and then assigns to it schedules
   * itself again forever, which is what effect_update_depth_exceeded is.
   */
  let running = $state(false);
  let elapsed = $state(0);
  /**
   * The "already started" guard, deliberately NOT reactive.
   *
   * A plain let is what keeps it out of the effect's dependencies. Asking
   * `running` to be both the guard and the display flag is what crashed
   * this card the moment anyone ran /ping.
   */
  let started = false;
  /** Set only when the component goes away, never by a re-render. */
  let stopped = false;

  const ceiling = $derived(chartCeiling(Object.values(samples).flat()));
  const liveStats = $derived.by(() => {
    const out: Record<string, Stats> = {};
    for (const t of cardState.targets) out[t.did] = summarize(samples[t.did] ?? []);
    return out;
  });
  /** Live while measuring, then whatever was published. */
  const shown = $derived(running || !done ? liveStats : cardState.results);

  // onMount, NOT $effect. An effect re-runs whenever anything it read
  // changes, and this one reads cardState through isOwner and done - which
  // the host recomputes as a fresh object every time any card state folds.
  // The re-run tore the probes down through the effect's cleanup while the
  // "already started" guard blocked them from restarting, so the card sat
  // on "starting..." forever, having measured nothing. A run belongs to the
  // component's lifetime, not to a dependency set.
  onMount(() => {
    // The owner measures once. Everyone else, and every later render of a
    // finished card, just reads.
    if (!isOwner || done || started) return;
    started = true;
    running = true;
    const startedAt = performance.now();
    const relayed = new Set<string>();

    const probe = async (did: string) => {
      while (!stopped && performance.now() - startedAt < WINDOW_MS) {
        if (host.isRelayed(did)) relayed.add(did);
        const rtt = await host.ping(did, { timeoutMs: PROBE_TIMEOUT_MS });
        if (stopped) return;
        const at = performance.now() - startedAt;
        samples = { ...samples, [did]: [...(samples[did] ?? []), { at, rtt }] };
        elapsed = at;
        await new Promise((r) => setTimeout(r, nextInterval(rtt)));
      }
    };

    // All targets on their own clocks: a slow peer must not hold up the
    // cadence of a fast one, which is what a shared loop would do.
    console.log(
      `[ping] probing ${cardState.targets.length} peer(s) for ${WINDOW_MS / 1000}s`
    );
    void Promise.all(cardState.targets.map((t) => probe(t.did))).then(() => {
      if (stopped) return;
      running = false;
      console.log("[ping] window closed, publishing summary");
      const results: Record<string, Stats> = {};
      for (const t of cardState.targets) {
        results[t.did] = summarize(samples[t.did] ?? []);
      }
      void host.sendUpdate(card.id, {
        action: "result",
        results,
        relayed: [...relayed],
      });
    });

  });

  onDestroy(() => {
    // Leaving the room mid-run stops the probes rather than letting them
    // keep measuring a card nobody is looking at.
    stopped = true;
  });

  /** Samples to an SVG polyline, dropping the gaps that loss leaves. */
  function line(list: Sample[]): string {
    return list
      .filter((s) => s.rtt !== null)
      .map((s) => {
        const x = (Math.min(s.at, WINDOW_MS) / WINDOW_MS) * 100;
        const y = 100 - Math.min(100, ((s.rtt as number) / ceiling) * 100);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  function ms(v: number | null): string {
    return v === null ? "-" : `${Math.round(v)}ms`;
  }
</script>

<div class="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
  <div class="flex items-baseline justify-between gap-2">
    <span class="font-mono text-xs font-semibold">Round trip</span>
    <span class="font-mono text-[10px] text-muted-foreground">
      {#if running}
        measuring {Math.round(elapsed / 1000)}s / {WINDOW_MS / 1000}s
      {:else if done}
        {WINDOW_MS / 1000}s window
      {:else if isOwner}
        starting...
      {:else}
        waiting for the result
      {/if}
    </span>
  </div>

  <div class="relative">
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      class="h-28 w-full rounded bg-muted/30"
      role="img"
      aria-label="Round trip over time"
    >
      <!-- A midline, so the shape has something to be read against. -->
      <line
        x1="0"
        y1="50"
        x2="100"
        y2="50"
        stroke="currentColor"
        stroke-opacity="0.12"
        stroke-width="0.4"
      />
      {#each cardState.targets as t, i (t.did)}
        {@const pts = line(samples[t.did] ?? [])}
        {#if pts}
          <polyline
            points={pts}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            stroke-width="1"
            vector-effect="non-scaling-stroke"
            stroke-linejoin="round"
          />
        {/if}
      {/each}
    </svg>
    <span
      class="pointer-events-none absolute right-1 top-0.5 font-mono text-[9px] text-muted-foreground"
      >{ceiling}ms</span
    >
  </div>

  <div class="flex flex-col gap-1">
    {#each cardState.targets as t, i (t.did)}
      {@const s = shown[t.did]}
      <div class="flex items-center gap-2 font-mono text-[11px]">
        <span
          class="size-2 shrink-0 rounded-full"
          style="background: {COLORS[i % COLORS.length]}"
        ></span>
        <span class="min-w-0 flex-1 truncate">{t.name}</span>
        {#if cardState.relayed.includes(t.did)}
          <!-- A relayed hop is peer to relay to peer, so it is structurally
               slower. Without saying so the graph looks like their
               connection is bad when the real answer is that we never
               managed a direct one. -->
          <span
            class="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] text-amber-500"
            >relayed</span
          >
        {/if}
        {#if s}
          <span class="shrink-0 text-muted-foreground">
            {ms(s.min)} / <span class="text-foreground">{ms(s.median)}</span> /
            {ms(s.max)}
          </span>
          {#if s.loss > 0}
            <span class="shrink-0 text-destructive"
              >{Math.round(s.loss * 100)}% lost</span
            >
          {/if}
        {/if}
      </div>
    {/each}
    <span class="font-mono text-[9px] text-muted-foreground">
      min / median / max, every {BASE_INTERVAL_MS}ms or slower on a struggling
      link
    </span>
  </div>
</div>
