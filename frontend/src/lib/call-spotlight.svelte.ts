/**
 * Shared spotlight calculation and utilities.
 *
 * AppView manages the state (clock, previous, PiP element) and exposes it
 * here so both CallPipPanel and the PiP video can access the same spotlight.
 */

import { buildCallTiles, type CallState } from "./call-tiles";
import type { SpotlightTile } from "./spotlight";
import type { SpeakerState } from "./spotlight";

export interface SpotlightState {
  /** Current spotlight tile ID */
  spotlightTileId: string | null;
  /** The full tile object for the current spotlight */
  spotlightTile: SpotlightTile | null;
  /** All tiles in the call */
  tiles: SpotlightTile[];
  /** Browser PiP video element, bound/passed by AppView */
  pipVideoElement: HTMLVideoElement | null;
  /** In-app panel video element, bound/passed by CallPipPanel */
  panelVideoElement: HTMLVideoElement | null;
}

// Module-level track start time tracking across rebuilds
export const trackStartTimes = new Map<string, number>();

/**
 * Build tiles with track start time tracking.
 *
 * Automatically records the first time each track appears so startedAt
 * is stable across spotlight changes.
 */
export function buildTilesWithTracking(callState: CallState): SpotlightTile[] {
  // No clock parameter on purpose: taking the ticking clock made the tile
  // list a dependency of it, so every tile object was rebuilt four times a
  // second and everything downstream (the srcObject swap included) re-ran.
  // First sight is the only time that matters, and startedAt is already read
  // off the map by the builder.
  const tiles = buildCallTiles({ ...callState, trackStartTimes });
  for (const tile of tiles) {
    if (tile.startedAt !== undefined && !trackStartTimes.has(tile.id)) {
      trackStartTimes.set(tile.id, tile.startedAt);
    }
  }
  for (const id of [...trackStartTimes.keys()]) {
    if (!tiles.some((t) => t.id === id)) trackStartTimes.delete(id);
  }
  return tiles;
}

/**
 * Create a canvas placeholder for avatar tiles.
 *
 * Each call creates a new canvas, drawn once. The stream's frame (frame 0)
 * stays on screen without redrawing: captureStream(0) returns a live stream
 * without further frame updates.
 *
 * @param label Peer's name or initials for the avatar
 * @param initial One-character initial for the avatar circle
 * @returns MediaStream for use as srcObject on a video element
 */
export function createCanvasPlaceholder(
  label: string,
  initial: string
): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Dark background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Avatar circle in center
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2.2;
    const radius = 60;

    // Gradient: slate to slate (neutral, matches dark theme)
    const gradient = ctx.createLinearGradient(
      centerX - radius,
      centerY - radius,
      centerX + radius,
      centerY + radius
    );
    gradient.addColorStop(0, "#475569");
    gradient.addColorStop(1, "#334155");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.fill();

    // Initial letter in white
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial.toUpperCase(), centerX, centerY);

    // Peer name below the circle
    ctx.fillStyle = "#d1d5db";
    ctx.font = "16px sans-serif";
    ctx.fillText(label, centerX, centerY + radius + 40);
  }

  return canvas.captureStream(0);
}

/**
 * Derive a speaking label for a tile.
 *
 * Returns "sharing" for screens, "speaking" for others when the peer is
 * active in the speakers state, empty string otherwise.
 */
export function getSpeakingLabel(
  tile: SpotlightTile,
  speakers: SpeakerState
): string {
  if (tile.kind === "screen" || tile.kind === "transmission") {
    return "sharing";
  }
  if (speakers.speaking.has(tile.peerId)) {
    return "speaking";
  }
  return "";
}

/**
 * Public store for the full spotlight state.
 *
 * Managed by AppView (which owns the clock, previous memory, and updates tiles)
 * and CallPipPanel (which provides its video element).
 * Contains references to both video elements so AppView can update both
 * on spotlight changes.
 */
export const spotlightStore = $state<SpotlightState>({
  spotlightTileId: null,
  spotlightTile: null,
  tiles: [],
  pipVideoElement: null,
  panelVideoElement: null,
});
