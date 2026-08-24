/**
 * Plugin card state store with reducer replay.
 * State materializes deterministically from persisted updates in fold order.
 */

import type { Message } from "$lib/transport/transport.svelte";
import type { PluginDefinition, UpdateCtx } from "./api";
import { MessageType, type ChatMessageType } from "$lib/types/message";
import { getAllMessages } from "$lib/storage";

export interface CardStateEntry {
  state: unknown;
  lastUpdate: number; // lamport of most recent update included
}

// Card state cache: cardId -> cached state
// Note: This is a regular Map, not $state, for testability.
// Reactivity is handled through component re-renders when state changes.
export const cardStates = new Map<string, CardStateEntry>();

// Change notification WITHOUT runes: this module is imported by node-run
// tests that have no Svelte compiler, which is why cardStates is a plain
// Map. Components subscribe a callback; MsgRender bridges it into its own
// $state. Without this, a card rendered once and live votes never appeared.
const _subscribers = new Set<() => void>();
export function onCardStateChange(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}
function bumpTick(): void {
  for (const cb of _subscribers) cb();
}

/**
 * Comparator for deterministic update ordering: lamport, then senderId, then id.
 * This is MSG_ORDER extended with id as tiebreaker for DM rooms.
 */
export function foldComparator(
  a: { lamport: number; senderId: string; id: string },
  b: { lamport: number; senderId: string; id: string }
): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  const senderCmp = a.senderId.localeCompare(b.senderId);
  if (senderCmp !== 0) return senderCmp;
  return a.id.localeCompare(b.id);
}

/**
 * Rebuild state for a plugin card from stored updates.
 * Called on first render of a card, queries storage for all PluginUpdate
 * messages referencing the cardId, folds through the reducer.
 */
export async function buildCardState(
  cardId: string,
  roomCode: string,
  definition: PluginDefinition
): Promise<unknown> {
  // The card's own payload seeds the state (a poll's question and options
  // live there); updates only ever mutate it.
  const allMessages = await getAllMessages(roomCode);
  let cardData: unknown = undefined;
  const cardMsg = allMessages.find((m) => m.id === cardId);
  if (cardMsg) {
    try {
      cardData = JSON.parse(cardMsg.content).data;
    } catch {
      // Malformed card: state starts unseeded and the card renders empty.
    }
  }

  if (!definition.reduce || !definition.initialState) {
    return definition.initialState ? definition.initialState(cardData) : undefined;
  }

  let state = definition.initialState(cardData);

  // Filter for PluginUpdate messages for this cardId
  const updates = allMessages.filter((msg) => {
    if (msg.type !== MessageType.PluginUpdate) return false;
    try {
      const payload = JSON.parse(msg.content);
      return payload.cardId === cardId;
    } catch {
      return false;
    }
  });

  // Sort by fold order (lamport, senderId, id)
  updates.sort(foldComparator);

  // Fold through reducer
  for (const msg of updates) {
    try {
      const payload = JSON.parse(msg.content);
      const ctx: UpdateCtx = {
        senderDid: msg.senderDid || msg.senderId,
        senderName: msg.senderName,
        updateId: msg.id,
        lamport: msg.lamport,
        ephemeral: false,
      };
      state = definition.reduce(state, { data: payload.data }, ctx);
    } catch (err) {
      console.warn(`[plugins] failed to fold update ${msg.id}:`, err);
    }
  }

  return state;
}

/**
 * Fold a single update into cached state (incremental).
 * Called for live updates that arrive after the initial state build.
 */
export function foldUpdate(
  cardId: string,
  definition: PluginDefinition,
  update: {
    id: string;
    senderId: string;
    senderDid?: string;
    senderName: string;
    lamport: number;
    data: unknown;
    ephemeral?: boolean;
  }
): unknown {
  if (!definition.reduce) {
    const entry = cardStates.get(cardId);
    return entry?.state;
  }

  const entry = cardStates.get(cardId);
  if (!entry) return undefined;

  const ctx: UpdateCtx = {
    senderDid: update.senderDid || update.senderId,
    senderName: update.senderName,
    updateId: update.id,
    lamport: update.lamport,
    ephemeral: update.ephemeral ?? false,
  };

  try {
    entry.state = definition.reduce(entry.state, { data: update.data }, ctx);
    bumpTick();
    entry.lastUpdate = update.lamport;
  } catch (err) {
    console.warn(`[plugins] failed to fold update ${update.id}:`, err);
  }

  return entry.state;
}

/**
 * Initialize or retrieve cached state for a card.
 * Returns cached state if available, otherwise builds it from storage.
 */
export async function getCardState(
  cardId: string,
  roomCode: string,
  definition: PluginDefinition
): Promise<unknown> {
  const entry = cardStates.get(cardId);
  if (entry) return entry.state;

  const state = await buildCardState(cardId, roomCode, definition);
  cardStates.set(cardId, { state, lastUpdate: 0 });
  bumpTick();
  return state;
}

/**
 * Clear all cached card states (on room switch or disconnect).
 */
export function clearCardStates(): void {
  cardStates.clear();
}
