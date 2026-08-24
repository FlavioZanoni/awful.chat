/**
 * Pure poll logic, separated from the Svelte component so tests exercise
 * the REAL reducer.
 */
import type { UpdateCtx } from "$lib/plugins/api";

export interface PollState {
  question: string;
  options: string[];
  votes: Map<string, { did: string; name: string; vote: number }>;
}

export const initialState = (cardData: unknown) => {
    const data = (cardData ?? {}) as { question?: unknown; options?: unknown };
    return {
      question: typeof data.question === "string" ? data.question : "",
      options: Array.isArray(data.options)
        ? data.options.filter((o): o is string => typeof o === "string")
        : [],
      votes: new Map<string, { did: string; name: string; vote: number }>(),
    };
  };

export const reduce = function (state: unknown, update: { data: unknown }, ctx: UpdateCtx) {
    const pollState = state as PollState;
    const data = update.data as Record<string, unknown>;

    // Only handle vote actions
    if (data.action !== "vote") return state;

    const vote = data.vote;
    // Peer-supplied: NaN slips past < and >= checks, so integers only.
    if (
      typeof vote !== "number" ||
      !Number.isInteger(vote) ||
      vote < 0 ||
      vote >= pollState.options.length
    ) {
      return state;
    }

    // Keep last vote per senderDid: replace if they already voted
    const newVotes = new Map(pollState.votes);
    newVotes.set(ctx.senderDid, {
      did: ctx.senderDid,
      name: ctx.senderName,
      vote,
    });

    return {
      ...pollState,
      votes: newVotes,
    };
  };
