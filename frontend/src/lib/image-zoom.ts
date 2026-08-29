/**
 * The arithmetic behind pinch and scroll zoom, kept away from the DOM so it
 * can be reasoned about and tested.
 *
 * The model: the image keeps its ordinary layout box (the "fit" size the
 * lightbox already gives it) and is then transformed by
 * `translate(pan) scale(zoom)` about its centre. Zoom 1 is therefore always
 * "fitted", whatever the picture's real dimensions are.
 */

export interface Point {
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * The pan that keeps the point under the cursor under the cursor.
 *
 * This is the whole difference between a zoom that works and one that
 * fights you: scaling about the centre means the corner you are trying to
 * read slides away exactly as you zoom towards it. `cursor` is measured
 * from the centre of the image's layout box, in screen pixels.
 */
export function zoomAbout(
  pan: Point,
  from: number,
  to: number,
  cursor: Point
): Point {
  if (from <= 0) return pan;
  const k = to / from;
  return {
    x: cursor.x - (cursor.x - pan.x) * k,
    y: cursor.y - (cursor.y - pan.y) * k,
  };
}

/**
 * Keep the image overlapping the viewport.
 *
 * Along an axis where the scaled image is smaller than the viewport there is
 * nothing to pan to, so it is pinned centred; otherwise it may travel only
 * as far as its own overhang. Without this an image can be flung out of
 * sight with no way to find it again.
 */
export function clampPan(
  pan: Point,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  zoom: number
): Point {
  const maxX = Math.max(0, (size.width * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (size.height * zoom - viewport.height) / 2);
  // The + 0 turns -0 back into 0. Clamping a negative pan against a zero
  // bound produces -0, which is harmless arithmetically and prints as
  // "translate(-0px, 0px)".
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, pan.y)) + 0,
  };
}

/**
 * The zoom at which one image pixel covers one screen pixel, for the
 * double-click "actual size" step. Below 1 there is nothing to reveal - the
 * picture is already larger on screen than it is in the file.
 */
export function actualSizeZoom(natural: number, rendered: number): number {
  if (rendered <= 0 || natural <= 0) return MIN_ZOOM;
  return clampZoom(natural / rendered);
}

/** Distance between two pointers, for pinch. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
