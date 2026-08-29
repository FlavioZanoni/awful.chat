import { describe, expect, it } from "vitest";
import {
  actualSizeZoom,
  clampPan,
  clampZoom,
  distance,
  midpoint,
  zoomAbout,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./image-zoom";

describe("clampZoom", () => {
  it("never goes below fit or past the ceiling", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(NaN)).toBe(MIN_ZOOM);
  });
});

describe("zoomAbout", () => {
  it("holds the point under the cursor still", () => {
    // The property that matters: whatever was under the cursor before the
    // zoom is under it after. Scaling about the centre instead is what makes
    // a zoom feel like it is fighting you.
    const pan = { x: 0, y: 0 };
    const cursor = { x: 120, y: -40 };
    const next = zoomAbout(pan, 1, 2, cursor);
    // The layout offset of the point under the cursor, before and after.
    const before = { x: (cursor.x - pan.x) / 1, y: (cursor.y - pan.y) / 1 };
    const after = { x: (cursor.x - next.x) / 2, y: (cursor.y - next.y) / 2 };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("is a no-op at the centre", () => {
    expect(zoomAbout({ x: 0, y: 0 }, 1, 3, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("does not divide by a zero scale", () => {
    expect(zoomAbout({ x: 5, y: 5 }, 0, 2, { x: 1, y: 1 })).toEqual({
      x: 5,
      y: 5,
    });
  });
});

describe("clampPan", () => {
  const size = { width: 400, height: 300 };
  const viewport = { width: 800, height: 600 };

  it("pins an image smaller than the viewport", () => {
    expect(clampPan({ x: 999, y: -999 }, size, viewport, 1)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("allows exactly the overhang once it is larger", () => {
    // 400*4 = 1600 wide against an 800 viewport: 400 of overhang each side.
    expect(clampPan({ x: 9999, y: 0 }, size, viewport, 4).x).toBe(400);
    expect(clampPan({ x: -9999, y: 0 }, size, viewport, 4).x).toBe(-400);
  });

  it("leaves a pan already inside the bounds alone", () => {
    expect(clampPan({ x: 50, y: 20 }, size, viewport, 4)).toEqual({
      x: 50,
      y: 20,
    });
  });

  it("clamps each axis on its own", () => {
    // Tall and narrow: room to pan vertically, none horizontally.
    const tall = { width: 100, height: 2000 };
    const out = clampPan({ x: 999, y: 999 }, tall, viewport, 1);
    expect(out.x).toBe(0);
    expect(out.y).toBe(700);
  });
});

describe("actualSizeZoom", () => {
  it("is the ratio of real pixels to rendered ones", () => {
    expect(actualSizeZoom(2000, 500)).toBe(4);
  });

  it("is fit when the picture is already larger on screen than in the file", () => {
    expect(actualSizeZoom(200, 500)).toBe(MIN_ZOOM);
  });

  it("survives a not-yet-measured element", () => {
    expect(actualSizeZoom(2000, 0)).toBe(MIN_ZOOM);
  });
});

describe("pinch helpers", () => {
  it("measures distance and midpoint", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 8 })).toEqual({ x: 2, y: 4 });
  });
});
