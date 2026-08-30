/**
 * Message search engine: corpus entries, filter matching, ranking.
 *
 * Pure module - no storage, no UI, no $state - so the whole pipeline is
 * unit-testable. The fuzzy scorer is the palette's fzf port; this module
 * only decides WHAT to match it against and how to rank what comes back.
 */
import { MessageType, type ChatMessageType } from "$lib/types/message";
import {
  match,
  matchExact,
  mergeRanges,
  type MatchRange,
} from "$lib/palette/scorer";
import type { SearchQuery } from "./query";

// Kind flags, matched by the has: filter.
export const HAS_FILE = 1;
export const HAS_IMAGE = 2;
export const HAS_VIDEO = 4;
export const HAS_AUDIO = 8;
export const HAS_GIF = 16;
export const HAS_LINK = 32;

export interface SearchEntry {
  id: string;
  roomCode: string;
  lamport: number;
  timestamp: number;
  senderDid: string;
  senderName: string;
  /** Original-case searchable text: content, filenames, plugin name. */
  text: string;
  /** Lowercased once at build time - lowercasing per keystroke is the cost
   *  the palette scorer's own comments warn about. */
  low: string;
  flags: number;
}

const SEARCHABLE: ReadonlySet<ChatMessageType> = new Set([
  MessageType.Text,
  MessageType.Reply,
  MessageType.File,
  MessageType.PluginCard,
]);

const LINK_RE = /(https?:\/\/|www\.)\S/i;

/** The subset of Message the entry builder reads. */
export interface SearchableMessage {
  id: string;
  roomCode: string;
  lamport: number;
  timestamp: number;
  senderId: string;
  senderDid?: string;
  senderName: string;
  type: ChatMessageType;
  content: string;
  meta?: {
    files?: Array<{ filename?: string; mimeType?: string }>;
  };
}

/**
 * Build a corpus entry, or null for message types search does not cover.
 * `pluginName` resolves a pluginId to its display name so "waffle party"
 * finds the card; the registry lookup stays with the caller.
 */
export function entryFromMessage(
  msg: SearchableMessage,
  pluginName?: (pluginId: string) => string | undefined
): SearchEntry | null {
  if (!SEARCHABLE.has(msg.type)) return null;
  const content = typeof msg.content === "string" ? msg.content : "";

  let text = content;
  let flags = 0;

  if (msg.type === MessageType.PluginCard) {
    let pluginId = "";
    try {
      const parsed = JSON.parse(content) as { pluginId?: string };
      if (typeof parsed.pluginId === "string") pluginId = parsed.pluginId;
    } catch {
      return null;
    }
    text = pluginName?.(pluginId) ?? pluginId;
  }

  if (msg.type === MessageType.File) {
    flags |= HAS_FILE;
    const names: string[] = [];
    for (const file of msg.meta?.files ?? []) {
      if (file.filename) names.push(file.filename);
      const mime = file.mimeType ?? "";
      if (mime === "image/gif") flags |= HAS_GIF;
      if (mime.startsWith("image/")) flags |= HAS_IMAGE;
      if (mime.startsWith("video/")) flags |= HAS_VIDEO;
      if (mime.startsWith("audio/")) flags |= HAS_AUDIO;
    }
    if (names.length) text = text ? `${text} ${names.join(" ")}` : names.join(" ");
  }

  if (LINK_RE.test(content)) flags |= HAS_LINK;

  return {
    id: msg.id,
    roomCode: msg.roomCode,
    lamport: msg.lamport,
    timestamp: msg.timestamp,
    senderDid: msg.senderDid || msg.senderId,
    senderName: msg.senderName,
    text,
    low: text.toLowerCase(),
    flags,
  };
}

export interface SearchHit {
  entry: SearchEntry;
  /** Rank score: match quality x recency decay. Comparable within one query. */
  score: number;
  /** Merged highlight ranges into `entry.text`. */
  ranges: MatchRange[];
}

/** Recency half-life: a hit ages to half its score every 30 days. */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Match one entry against a parsed query. Null when any filter or term
 * fails. Zero terms with a filter is valid ("has:image") and ranks purely
 * by recency.
 */
export function matchEntry(
  entry: SearchEntry,
  q: SearchQuery,
  nowMs: number
): SearchHit | null {
  if ((entry.flags & q.has) !== q.has) return null;
  if (q.before !== null && entry.timestamp >= q.before) return null;
  if (q.after !== null && entry.timestamp < q.after) return null;
  if (q.from !== null) {
    const nameHit = match(entry.senderName.toLowerCase(), q.from);
    if (!nameHit && !entry.senderDid.toLowerCase().startsWith(q.from))
      return null;
  }

  let termScore = 0;
  const allRanges: MatchRange[] = [];
  for (const term of q.terms) {
    const hit = term.exact
      ? matchExact(entry.low, term.text)
      : match(entry.low, term.text);
    if (!hit) return null;
    termScore += hit.score;
    for (const p of hit.positions)
      allRanges.push({ start: p, end: p + 1 });
  }

  const age = Math.max(0, nowMs - entry.timestamp);
  const decay = Math.pow(2, -age / HALF_LIFE_MS);
  return {
    entry,
    score: (1 + termScore) * decay,
    ranges: mergeRanges(allRanges),
  };
}

/** Sort best-first; recency (lamport) breaks ties. Truncates to `limit`. */
export function rankHits(hits: SearchHit[], limit: number): SearchHit[] {
  hits.sort(
    (a, b) => b.score - a.score || b.entry.lamport - a.entry.lamport
  );
  return hits.length > limit ? hits.slice(0, limit) : hits;
}

export interface Snippet {
  /** Slice of entry.text around the first match. */
  text: string;
  /** Highlight ranges rebased into `text`. */
  ranges: MatchRange[];
  leading: boolean;
  trailing: boolean;
}

const SNIPPET_CHARS = 120;

/** Window the text around the first highlight so the match is visible. */
export function snippetFor(entry: SearchEntry, ranges: MatchRange[]): Snippet {
  const full = entry.text;
  if (full.length <= SNIPPET_CHARS || ranges.length === 0) {
    const text = full.slice(0, SNIPPET_CHARS);
    return {
      text,
      ranges: ranges.filter((r) => r.start < text.length).map((r) => ({
        start: r.start,
        end: Math.min(r.end, text.length),
      })),
      leading: false,
      trailing: full.length > SNIPPET_CHARS,
    };
  }
  const anchor = ranges[0].start;
  let start = Math.max(0, anchor - Math.floor(SNIPPET_CHARS / 3));
  // Snap to a word boundary so the snippet does not open mid-word.
  const space = full.lastIndexOf(" ", start);
  if (space > 0 && start - space < 16) start = space + 1;
  const end = Math.min(full.length, start + SNIPPET_CHARS);
  return {
    text: full.slice(start, end),
    ranges: ranges
      .filter((r) => r.end > start && r.start < end)
      .map((r) => ({
        start: Math.max(0, r.start - start),
        end: Math.min(end - start, r.end - start),
      })),
    leading: start > 0,
    trailing: end < full.length,
  };
}
