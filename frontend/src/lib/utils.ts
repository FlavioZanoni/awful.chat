import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any }
  ? Omit<T, "children">
  : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null;
};

/** Encode a Uint8Array to a lowercase hex string. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode a hex string to a Uint8Array. Throws on odd-length input. */
export function unhex(h: string): Uint8Array<ArrayBuffer> {
  if (h.length % 2 !== 0) throw new Error("Invalid hex string length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode a UTF-8 string to a Uint8Array. */
export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/**
 * Image mime from magic bytes. Data-url mimes were hardcoded (jpeg for
 * avatars, gif for banners) and only worked because browsers sniff the real
 * bytes; anything that trusts the declared type would mis-handle them.
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45
  )
    return "image/webp";
  return "image/jpeg"; // ponytail: unknown bytes get the sniffing-tolerant default
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode blows the arg limit past ~64k
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function decode(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

/** Base64 raster image, no svg+xml: SVG can carry script and external refs. */
const DATA_AVATAR_RE =
  /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/;

/** ~1.4 MB of base64, i.e. about a 1 MB image. */
const MAX_DATA_AVATAR_LEN = 1_400_000;

/**
 * Only 6-digit hex colors survive. Nickname colors end up in inline style
 * attributes, so anything wider (CSS expressions, url(), named colors) is
 * rejected instead of trusted from the wire.
 */
const NICKNAME_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeNicknameColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return NICKNAME_COLOR_RE.test(value) ? value.toLowerCase() : undefined;
}

export function normalizeAvatarUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  // An avatar picked from the device is sent inline as a data: URL - rejecting
  // those meant uploaded pictures never propagated to anyone, only linked ones.
  if (url.startsWith("data:")) {
    if (url.length > MAX_DATA_AVATAR_LEN) return undefined;
    return DATA_AVATAR_RE.test(url) ? url : undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Simple deterministic PRNG seeded from a string.
 * Uses mulberry32-style algorithm for determinism.
 * Same seed always produces the same sequence.
 */
export function seededRandom(seed: string): () => number {
  // Hash the seed string to a number
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Mulberry32 PRNG
  return function () {
    hash |= 0; // Ensure it's a 32-bit integer
    hash = (hash + 0x6d2b79f5) | 0;
    let t = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
