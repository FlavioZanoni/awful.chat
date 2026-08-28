import { describe, it, expect } from "vitest";
import {
  coverBaseScale,
  clampOffset,
  rectFromView,
} from "./crop-geometry";

describe("coverBaseScale", () => {
  it("picks the larger ratio so the frame is always covered", () => {
    // A wide frame over a square image is bound by the width ratio.
    expect(coverBaseScale(100, 100, 50, 25)).toBe(0.5);
    // A tall frame over a wide image is bound by the height ratio.
    expect(coverBaseScale(200, 100, 50, 80)).toBe(0.8);
  });

  it("returns 1 for degenerate sizes", () => {
    expect(coverBaseScale(0, 100, 50, 50)).toBe(1);
  });
});

describe("clampOffset", () => {
  it("keeps a larger image from uncovering the frame", () => {
    // disp 200, frame 100 -> offset allowed in [-100, 0]
    expect(clampOffset(10, 200, 100)).toBe(0);
    expect(clampOffset(-40, 200, 100)).toBe(-40);
    expect(clampOffset(-150, 200, 100)).toBe(-100);
  });
});

describe("rectFromView", () => {
  it("selects the centered half of a wide image at cover scale", () => {
    const rect = rectFromView({
      natW: 200,
      natH: 100,
      frameW: 100,
      frameH: 100,
      scale: 1, // cover scale for this pairing
      offsetX: -50, // centered
      offsetY: 0,
    });
    expect(rect).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
  });

  it("shrinks the selection as the user zooms in", () => {
    const rect = rectFromView({
      natW: 100,
      natH: 100,
      frameW: 100,
      frameH: 100,
      scale: 2, // zoomed 2x
      offsetX: -50,
      offsetY: -50,
    });
    expect(rect).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });

  it("clamps the rectangle inside the image bounds", () => {
    const rect = rectFromView({
      natW: 100,
      natH: 100,
      frameW: 100,
      frameH: 100,
      scale: 2,
      offsetX: 999, // out of range, should clamp to a valid window
      offsetY: -999,
    });
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1);
  });
});
