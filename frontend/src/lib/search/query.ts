/**
 * Search query language: bare fuzzy terms, "quoted exact phrases", and
 * Discord-style filter prefixes (from:, in:, has:, before:, after:).
 * Anything unrecognized degrades to a plain text term - a filter typo
 * narrows nothing instead of erroring.
 */
import {
  HAS_AUDIO,
  HAS_FILE,
  HAS_GIF,
  HAS_IMAGE,
  HAS_LINK,
  HAS_VIDEO,
} from "./engine";

export interface SearchTerm {
  /** Lowercased; the scorer requires it. */
  text: string;
  exact: boolean;
}

export interface SearchQuery {
  terms: SearchTerm[];
  /** Lowercased sender filter, or null. */
  from: string | null;
  /** Lowercased room-name filter (global scope only), or null. */
  inRoom: string | null;
  /** Required kind flags, ANDed. */
  has: number;
  /** Exclusive upper timestamp bound (ms), or null. */
  before: number | null;
  /** Inclusive lower timestamp bound (ms), or null. */
  after: number | null;
}

const HAS_FLAGS: Record<string, number> = {
  file: HAS_FILE,
  image: HAS_IMAGE,
  video: HAS_VIDEO,
  audio: HAS_AUDIO,
  gif: HAS_GIF,
  link: HAS_LINK,
};

/** Start of the local day the given date sugar or YYYY-MM-DD names. */
function dayStart(value: string, now: number): number | null {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (value === "today") return today.getTime();
  if (value === "yesterday") return today.getTime() - 24 * 60 * 60 * 1000;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

export function parseSearchQuery(raw: string, now = Date.now()): SearchQuery {
  const q: SearchQuery = {
    terms: [],
    from: null,
    inRoom: null,
    has: 0,
    before: null,
    after: null,
  };

  // Quoted segments become exact terms; everything else splits on spaces.
  const tokenRe = /"([^"]*)"|(\S+)/g;
  for (const m of raw.matchAll(tokenRe)) {
    if (m[1] !== undefined) {
      const text = m[1].toLowerCase().trim();
      if (text) q.terms.push({ text, exact: true });
      continue;
    }
    const token = m[2];
    const filter = token.match(/^([a-z]+):(.+)$/i);
    if (filter) {
      const key = filter[1].toLowerCase();
      const value = filter[2].toLowerCase();
      if (key === "from") {
        q.from = value;
        continue;
      }
      if (key === "in") {
        q.inRoom = value;
        continue;
      }
      if (key === "has" && HAS_FLAGS[value] !== undefined) {
        q.has |= HAS_FLAGS[value];
        continue;
      }
      if (key === "before" || key === "after") {
        const t = dayStart(value, now);
        if (t !== null) {
          if (key === "before") q.before = t;
          else q.after = t;
          continue;
        }
      }
      // Unknown filter or bad value: fall through as plain text.
    }
    q.terms.push({ text: token.toLowerCase(), exact: false });
  }

  return q;
}

/** True when the query would match everything (nothing typed yet). */
export function isEmptyQuery(q: SearchQuery): boolean {
  return (
    q.terms.length === 0 &&
    q.from === null &&
    q.inRoom === null &&
    q.has === 0 &&
    q.before === null &&
    q.after === null
  );
}
