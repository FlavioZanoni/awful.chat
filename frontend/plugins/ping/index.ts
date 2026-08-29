import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import PingCard from "./PingCard.svelte";
import { MAX_TARGETS, parsePingArgs, type Stats } from "./logic";

export interface PingTarget {
  did: string;
  name: string;
}

export interface PingState {
  targets: PingTarget[];
  /** Whose measurement this is. Only they probe; everyone else reads. */
  ownerDid: string;
  /** Filled in once the window closes, keyed by target DID. */
  results: Record<string, Stats>;
  /** Peers that were reached through a relay for the whole run. */
  relayed: string[];
}

export function initialState(cardData: unknown): PingState {
  const data = cardData as Record<string, unknown> | undefined;
  const raw = Array.isArray(data?.targets) ? data.targets : [];
  const targets: PingTarget[] = [];
  for (const t of raw) {
    const did = (t as PingTarget)?.did;
    const name = (t as PingTarget)?.name;
    if (typeof did !== "string" || !did) continue;
    if (targets.some((x) => x.did === did)) continue;
    targets.push({ did, name: typeof name === "string" ? name : did });
    if (targets.length >= MAX_TARGETS) break;
  }
  return {
    targets,
    // Empty means nobody owns it, and the reducer below refuses every
    // update - the same fail-closed shape a forged card should have.
    ownerDid: typeof data?.ownerDid === "string" ? data.ownerDid : "",
    results: {},
    relayed: [],
  };
}

export function reduce(
  prev: unknown,
  update: { data: unknown },
  ctx: { senderDid: string }
): PingState {
  // The host hands state back as unknown - it does not know a plugin's
  // shape - so the narrowing happens here rather than in the signature.
  const state = prev as PingState;
  const data = update.data as Record<string, unknown>;
  // Strict, never `state.ownerDid && ...`: that guard reads as "check when
  // there is an owner" and behaves as "skip the check when there is not".
  if (ctx.senderDid !== state.ownerDid) return state;
  if (data?.action !== "result") return state;
  const results = data.results as Record<string, Stats> | undefined;
  if (!results || typeof results !== "object") return state;
  const kept: Record<string, Stats> = {};
  for (const t of state.targets) {
    const s = results[t.did];
    if (s && typeof s === "object") kept[t.did] = s;
  }
  return {
    ...state,
    results: kept,
    relayed: Array.isArray(data.relayed)
      ? (data.relayed as string[]).filter((d) =>
          state.targets.some((t) => t.did === d)
        )
      : [],
  };
}

export default definePlugin({
  manifest,
  card: PingCard,
  initialState,
  reduce,
  commands: {
    ping: async (args: string, host: HostApi) => {
      const names = parsePingArgs(args);
      if (names.length === 0) {
        console.warn("[ping] format: /ping @alice, @bob, @carol");
        return;
      }
      const online = host.peers();
      const targets: PingTarget[] = [];
      for (const name of names) {
        const match = online.find(
          (p) => p.name.toLowerCase() === name.toLowerCase()
        );
        // Silently pinging somebody who is not here would draw a graph of
        // nothing but loss and look like their connection was the problem.
        if (match) targets.push({ did: match.did, name: match.name });
        else console.warn(`[ping] nobody called ${name} is in this room`);
      }
      if (targets.length === 0) return;
      await host.sendCard({ targets, ownerDid: host.selfDid() });
    },
  },
});
