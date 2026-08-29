/**
 * Room codes.
 *
 * The code IS the membership secret: it names the gossipsub topic, keys the
 * relay's rendezvous, and is the SFU's join key. There is no roster and no
 * second factor, so anyone holding it reads the room's plaintext chat and can
 * consume its camera and screen streams.
 *
 * It used to be 3 random bytes - 24 bits, 16.7 million codes. Guessing is
 * online only (you have to reach the relay or the SFU to test one), but with R
 * rooms live the expected cost of hitting SOME room is 2^24/R, which is a few
 * hundred thousand tries on a busy instance: hours, not centuries.
 *
 * 64 bits takes that to 2^64. At a wildly generous 10,000 guesses per second
 * against the network, exhausting a millionth of that space still takes
 * centuries, and there is no offline oracle to speed it up. 128 bits would buy
 * nothing further and doubles a string people sometimes read aloud.
 *
 * Alphabet: Crockford base32 - 13 characters for 65 bits, no O/0 or I/1/L
 * confusion, case-insensitive on input. Shown as XXXX-XXXX-XXXX-X. The wire
 * form is the bare uppercase string; the relay, the SFU and the client all
 * treat a code as an opaque string, so the earlier 16-char hex codes (and the
 * 6-char ones before them) keep working unchanged, and keep their entropy -
 * a room cannot be re-keyed without becoming a different room.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ROOM_CODE_LEN = 13;
const ROOM_CODE_RE = new RegExp(`^[${ALPHABET}]{${ROOM_CODE_LEN}}$`);

export function newRoomCode(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(ROOM_CODE_LEN)),
    (b) => ALPHABET[b & 31]
  ).join("");
}

/**
 * What a person typed or pasted, as the wire form. Only a base32 code is
 * touched (separators dropped, uppercased, look-alikes folded); anything
 * else - a legacy hex code, a short invite - is returned trimmed, so the
 * legacy lowercase hex is never mangled.
 */
export function normalizeRoomCode(input: string): string {
  const trimmed = input.trim();
  const folded = trimmed
    .replace(/[-\s]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return ROOM_CODE_RE.test(folded) ? folded : trimmed;
}

/** For display: `6BMB3GST2JRJZ` -> `6BMB-3GST-2JRJ-Z`; other codes as is. */
export function formatRoomCode(code: string): string {
  if (!ROOM_CODE_RE.test(code)) return code;
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`;
}
