/**
 * Pure geometry for the image cropper. The cropper shows the image behind a
 * fixed crop frame; the user pans and zooms the image. These helpers convert
 * that view state into a normalized {@link CropRect} and keep the image large
 * enough to always cover the frame.
 *
 * Kept DOM-free so the math is unit-testable.
 */
import type { CropRect } from "./crop";

export interface ViewState {
  /** Natural image size in pixels. */
  natW: number;
  natH: number;
  /** Crop frame size in pixels, on screen. */
  frameW: number;
  frameH: number;
  /** Absolute display scale applied to the natural image. */
  scale: number;
  /** Image top-left offset within the frame's coordinate space (<= 0). */
  offsetX: number;
  offsetY: number;
}

/** The smallest scale at which the image still covers the whole frame. */
export function coverBaseScale(
  natW: number,
  natH: number,
  frameW: number,
  frameH: number
): number {
  if (natW <= 0 || natH <= 0) return 1;
  return Math.max(frameW / natW, frameH / natH);
}

/** Clamp one offset axis so the scaled image never uncovers the frame. */
export function clampOffset(
  offset: number,
  dispSize: number,
  frameSize: number
): number {
  // The image left/top edge can sit at 0 (flush) down to frameSize - dispSize
  // (its right/bottom edge flush). When the image is not larger than the frame
  // both bounds collapse to a centered position.
  const min = Math.min(0, frameSize - dispSize);
  if (offset > 0) return 0;
  if (offset < min) return min;
  return offset;
}

/** Convert the current view into a normalized crop rectangle. */
export function rectFromView(v: ViewState): CropRect {
  const dispW = v.natW * v.scale;
  const dispH = v.natH * v.scale;
  const ox = clampOffset(v.offsetX, dispW, v.frameW);
  const oy = clampOffset(v.offsetY, dispH, v.frameH);

  const w = clamp01(v.frameW / dispW);
  const h = clamp01(v.frameH / dispH);
  const x = clamp01(-ox / dispW, 1 - w);
  const y = clamp01(-oy / dispH, 1 - h);
  return { x, y, w, h };
}

function clamp01(n: number, max = 1): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > max ? max : n;
}
