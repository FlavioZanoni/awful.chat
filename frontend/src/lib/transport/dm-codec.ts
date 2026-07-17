/**
 * dm-codec.ts — pure encode/decode for the DM wire envelopes and the
 * deterministic DM room-code hash. No transport or Svelte dependencies,
 * so it is unit-testable in isolation.
 *
 * Envelope layout: 1 tag byte + payload.
 *   0x01 chat  — JSON { id, text, ts }
 *   0x02 ack   — raw messageId string (delivery receipt)
 *   0x03 read  — JSON string[] of messageIds (read receipt)
 */

export interface DmPayload {
  id: string;
  text: string;
  ts: number;
}

export const DM_CHAT_TAG = 0x01;
export const DM_ACK_TAG = 0x02;
export const DM_READ_TAG = 0x03;

const DM_ROOM_PREFIX = "dm-";
const _dmRoomCodeCache = new Map<string, string>();

/**
 * Generate a stable, deterministic DM room code from two DIDs.
 * - Sort the two DIDs alphabetically
 * - Hash them to create a short stable identifier
 * - Prefix with "dm-" for easy identification
 */
export async function hashDmRoomCode(
  did1: string,
  did2: string
): Promise<string> {
  const input = [did1, did2].sort().join("|");
  const cached = _dmRoomCodeCache.get(input);
  if (cached) return cached;

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  // First 20 bytes (40 hex chars) + "dm-" prefix = 43 chars total
  const hashHex = Array.from(new Uint8Array(hashBuffer).slice(0, 20))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const roomCode = `${DM_ROOM_PREFIX}${hashHex}`;
  _dmRoomCodeCache.set(input, roomCode);
  return roomCode;
}

function tagged(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

export function encodeDmChatEnvelope(payload: DmPayload): Uint8Array {
  return tagged(DM_CHAT_TAG, new TextEncoder().encode(JSON.stringify(payload)));
}

export function encodeDmAckEnvelope(messageId: string): Uint8Array {
  return tagged(DM_ACK_TAG, new TextEncoder().encode(messageId));
}

export function encodeDmReadEnvelope(messageIds: string[]): Uint8Array {
  return tagged(
    DM_READ_TAG,
    new TextEncoder().encode(JSON.stringify(messageIds))
  );
}

export function parseDmEnvelope(
  data: Uint8Array
):
  | { type: "chat"; payload: DmPayload }
  | { type: "ack"; messageId: string }
  | { type: "read"; messageIds: string[] }
  | null {
  if (data.byteLength < 1) return null;
  const tag = data[0];
  const payload = data.subarray(1);
  try {
    if (tag === DM_CHAT_TAG) {
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as DmPayload;
      if (
        typeof parsed?.id !== "string" ||
        typeof parsed?.text !== "string" ||
        typeof parsed?.ts !== "number"
      ) {
        return null;
      }
      return { type: "chat", payload: parsed };
    }
    if (tag === DM_ACK_TAG) {
      return { type: "ack", messageId: new TextDecoder().decode(payload) };
    }
    if (tag === DM_READ_TAG) {
      const ids = JSON.parse(new TextDecoder().decode(payload));
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        return null;
      }
      return { type: "read", messageIds: ids };
    }
  } catch {
    return null;
  }
  return null;
}
