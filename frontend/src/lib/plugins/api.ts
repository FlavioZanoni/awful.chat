import type { ComponentType } from "svelte";

export interface PluginManifest {
  id: string; // ^[a-z0-9-]{2,32}$, folder name must match
  name: string;
  description: string;
  /** Shown in the plugins settings list. */
  author?: string;
  /** SPDX-ish string, e.g. "MIT". Shown next to the author. */
  license?: string; // one line, shown in settings
  /** Shown on the card header and in settings, e.g. "1.2.0". */
  version?: string;
  /** An emoji, or a lucide icon as "lucide:<kebab-name>" (e.g. "lucide:dices"). */
  icon: string;
  apiVersion: 1;
  /**
   * Slash commands this plugin offers, for the composer's "/" popup. Lives
   * in the manifest because the popup must list commands WITHOUT loading
   * plugin code. Names must match the keys of the definition's `commands`.
   */
  commands?: Array<{ name: string; usage: string }>;
}

export interface UpdateCtx {
  senderDid: string; // host-verified, never from payload
  senderName: string;
  updateId: string; // message id, stable across peers
  lamport: number;
  ephemeral: boolean;
}

export interface HostApi {
  // Built by GENERALIZING sendMessage, never as a parallel path: signing
  // (sigV2), lamport assignment (room counter vs wall-clock nextDmLamport
  // for dm- rooms), putMessage, setWatermark, appendSorted, markRoomSeen,
  // noteRoomActivity all live there, and parallel send paths are where this
  // codebase's historical bugs came from.
  sendCard(payload: unknown): Promise<string>; // returns cardId
  sendUpdate(
    cardId: string,
    payload: unknown,
    opts?: { ephemeral?: boolean }
  ): Promise<void>;
  roomCode(): string;
  selfDid(): string;
  peers(): Array<{ did: string; name: string }>;
  onPeerDisconnect(
    listener: (peer: { did: string; name: string }) => void
  ): () => void;
  onBeforeDisconnect(listener: () => void): () => void;
  sendUpdateImmediately(cardId: string, payload: unknown): void;
  cards(): Promise<Array<{ id: string; senderDid: string }>>;
  seededRandom(seed: string): () => number; // deterministic PRNG
  storage: {
    get(k: string): Promise<unknown>;
    set(k: string, v: unknown): Promise<void>;
  };
}

export interface PluginDefinition {
  manifest: PluginManifest;
  // Svelte component rendering a card. Props: { card, state, host }.
  card?: ComponentType;
  // Pure reducer. Host feeds persisted updates in lamport order (history
  // replay first, then live), ephemeral updates live only.
  reduce?: (state: unknown, update: PluginUpdate, ctx: UpdateCtx) => unknown;
  /**
   * Build the starting state for one card. Receives the card's payload (the
   * object passed to host.sendCard) so options/questions seed the state -
   * without it a reducer bounds-checking against state saw empty data and
   * rejected every update.
   */
  initialState?: (cardData: unknown) => unknown;
  commands?: Record<
    string,
    (args: string, host: HostApi) => void | Promise<void>
  >;
}

// Internal message format: JSON stringified into content field
export interface PluginCardPayload {
  pluginId: string;
  data: unknown;
}

export interface PluginUpdatePayload {
  pluginId: string;
  cardId: string;
  data: unknown;
}

export interface PluginEphemeralPayload {
  pluginId: string;
  cardId: string;
  data: unknown;
}

export interface PluginUpdate {
  data: unknown;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
