/**
 * The one place a HostApi is built. Cards rendered in chat and slash-command
 * handlers get the SAME object shape from the same code - the first version
 * had ChatView building a host inline and MsgRender passing a bare `{}`,
 * which crashed the first time a card called host.sendUpdate.
 */
import type { HostApi } from "./api";
import { seededRandom } from "$lib/utils";
import { identityStore } from "$lib/identity/identity.svelte";
import { transportState } from "$lib/transport/transport.svelte";

export function makeHostApi(pluginId: string, roomCode: string): HostApi {
  return {
    async sendCard(payload) {
      const { sendCard } = await import("$lib/transport/transport.svelte");
      return sendCard(pluginId, payload);
    },
    async sendUpdate(cardId, payload, opts) {
      const { sendUpdate } = await import("$lib/transport/transport.svelte");
      return sendUpdate(pluginId, cardId, payload, opts);
    },
    roomCode: () => roomCode,
    selfDid: () => identityStore.did || "",
    peers: () =>
      Array.from(transportState.peerNames).map(([did, name]) => ({
        did,
        name,
      })),
    seededRandom,
    // ponytail: localStorage-backed plugin storage, namespaced per plugin.
    // Move to IndexedDB when a plugin actually outgrows string-sized values.
    storage: {
      async get(k: string) {
        try {
          const raw = localStorage.getItem(`awful:plugin:${pluginId}:${k}`);
          return raw === null ? undefined : JSON.parse(raw);
        } catch {
          return undefined;
        }
      },
      async set(k: string, v: unknown) {
        try {
          localStorage.setItem(
            `awful:plugin:${pluginId}:${k}`,
            JSON.stringify(v)
          );
        } catch {
          // Storage blocked: the value just does not survive a reload.
        }
      },
    },
  };
}
