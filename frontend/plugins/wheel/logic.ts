/**
 * Pure wheel logic, separated from the Svelte component so tests exercise
 * the REAL reducer - the first test suite re-implemented the logic inline
 * and passed while the plugin itself was broken.
 */
import type { UpdateCtx } from "$lib/plugins/api";

export interface WheelState {
  options: string[];
  spun: boolean;
  winner: number | null;
  spinnerName: string;
}

// Deterministic hash function for seed string
export function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash >>> 0;
}

export const initialState = (cardData: unknown) => {
    const data = (cardData ?? {}) as { options?: unknown };
    return {
      options: Array.isArray(data.options)
        ? data.options.filter((o): o is string => typeof o === "string")
        : [],
      spun: false,
      winner: null,
      spinnerName: "",
    };
  };

export const reduce = function (state: unknown, update: { data: unknown }, ctx: UpdateCtx) {
    const wheelState = state as WheelState;
    const data = update.data as Record<string, unknown>;

    // Only handle spin actions
    if (data.action !== "spin") return state;

    // First spin wins, later spins are no-ops
    if (wheelState.spun) return state;

    // Determine winner from seeded random
    const winnerSeed = `${ctx.updateId}|${ctx.senderDid}`;
    const hash = hashSeed(winnerSeed);

    if (wheelState.options.length === 0) return state;
    const winner = hash % wheelState.options.length;

    return {
      ...wheelState,
      spun: true,
      winner,
      spinnerName: ctx.senderName,
    };
  };
