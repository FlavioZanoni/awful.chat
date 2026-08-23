// STUN servers - safe to ship, no credentials.
//
// Two, not seven. Gathering does not finish until every entry has answered or
// timed out, and the extras bought nothing: stun2/3/4.l.google.com are the
// same anycast service as these and return the same reflexive candidate, while
// stun:openrelay.metered.ca and stun:stun.twilio.com have no DNS record at all
// (checked against 8.8.8.8) - every peer connection was waiting on two lookups
// that can only fail.
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  // Not stun1.l.google.com: it resolves to the SAME address as the line above
  // (74.125.250.129 when checked), so the pair was one server wearing two
  // names. Cloudflare is a second anycast provider at the same latency, which
  // is what redundancy was supposed to mean.
  { urls: "stun:stun.cloudflare.com:3478" },
];

// Static TURN for awful.frav.in - only a FALLBACK, used until the relay hands
// out short-lived HMAC credentials (see refreshTurnCredentials). Shipping a
// permanent shared secret lets anyone relay through the server, so the relay's
// /turn-credentials endpoint (coturn use-auth-secret) supersedes this whenever
// TURN_SECRET is configured.
const STATIC_TURN: RTCIceServer = {
  urls: [
    "turn:awful.frav.in:3478?transport=udp",
    "turn:awful.frav.in:3478?transport=tcp",
    // Port 5349 (both turn: and turns:) is dropped, not refused - a TCP
    // connect there times out rather than failing fast, so the two entries
    // that used to live here cost every peer connection a full connect
    // timeout before ICE could give up on them. Put them back the moment
    // coturn is actually listening on 5349 with a certificate: TLS TURN is
    // what restrictive mobile carriers still let through.
  ],
  username: "awful",
  credential: "awful",
};

// ponytail: openrelay.metered.ca was the "last resort" TURN and its domain no
// longer resolves, so all three entries were dead weight on every connection -
// a relay candidate that can never gather, three allocations that can only
// time out. Removed rather than replaced: awful.frav.in is the only TURN we
// control. If a real fallback is wanted, add one host that resolves.
function withTurn(turn: RTCIceServer): RTCIceServer[] {
  return [...STUN_SERVERS, turn];
}

// Current ICE server list. Starts with the static TURN fallback and is upgraded
// in place to short-lived credentials once refreshTurnCredentials() succeeds.
let cached: RTCIceServer[] = withTurn(STATIC_TURN);

/** ICE servers for a new RTCPeerConnection. Read synchronously at PC creation. */
export function getIceServers(): RTCIceServer[] {
  return cached;
}

/**
 * Fetch short-lived TURN credentials from the relay and swap them into the
 * cached ICE list. Best-effort: on any failure (endpoint absent, TURN_SECRET
 * unset → 204, network error, malformed body) the static fallback stays in
 * place so calls/transfers keep working. Cheap to call on every connect.
 */
export async function refreshTurnCredentials(): Promise<void> {
  try {
    const base =
      (import.meta.env.VITE_API_URL as string | undefined) ||
      "https://awful.frav.in";
    const res = await fetch(`${base}/turn-credentials`);
    if (!res.ok) return; // error → keep fallback
    // 204 is the relay saying TURN_SECRET is unset. It is a documented,
    // supported state, not a fault - and it is `ok`, so it has to be caught
    // here or it falls through to a JSON parse of an empty body.
    if (res.status === 204) return;
    // A host that answers an unrouted path with index.html returns 200 too, so
    // res.ok is not enough on its own: the JSON parse below would throw into
    // the silent catch and leave the static credentials in place with nothing
    // logged. That is what a deploy without VITE_API_URL looks like.
    if (!res.headers.get("content-type")?.includes("application/json")) {
      console.warn(
        "[ice] /turn-credentials did not return JSON - still using the static TURN credentials"
      );
      return;
    }
    const d = (await res.json()) as {
      username?: unknown;
      credential?: unknown;
      urls?: unknown;
    };
    if (
      typeof d?.username !== "string" ||
      typeof d?.credential !== "string" ||
      !Array.isArray(d?.urls) ||
      d.urls.length === 0 ||
      !d.urls.every((u) => typeof u === "string")
    ) {
      return;
    }
    cached = withTurn({
      urls: d.urls as string[],
      username: d.username,
      credential: d.credential,
    });
  } catch {
    // keep the static fallback
  }
}

/**
 * @deprecated Use getIceServers() - this is a snapshot and won't reflect a
 * later credential refresh. Retained for any external import.
 */
export const defaultIceServerList: RTCIceServer[] = cached;
