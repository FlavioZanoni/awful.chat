import { describe, expect, it } from "vitest";
import { mediaBoxStyle, isSaneDimension } from "./image-size";

describe("isSaneDimension", () => {
  it("takes ordinary pixel counts", () => {
    expect(isSaneDimension(1)).toBe(true);
    expect(isSaneDimension(4032)).toBe(true);
  });

  it("refuses what a hostile peer could put in an aspect-ratio", () => {
    // These arrive inside a signed message, which proves the sender and
    // nothing about their honesty.
    for (const bad of [0, -5, 1e9, 20001, 1.5, NaN, Infinity, "800", null, undefined]) {
      expect(isSaneDimension(bad)).toBe(false);
    }
  });
});

describe("mediaBoxStyle", () => {
  it("holds a box for a video too, not only an image", () => {
    // A video with no dimensions lays out as the browser's default 300x150
    // and resizes when metadata lands, which is the same shift an image has.
    expect(mediaBoxStyle(1920, 1080)).toBe(
      "width: 20.000rem; aspect-ratio: 1920 / 1080;"
    );
  });

  it("is empty when the dimensions are missing, so nothing changes", () => {
    expect(mediaBoxStyle(undefined, undefined)).toBe("");
    expect(mediaBoxStyle(800, undefined)).toBe("");
  });

  it("is empty for out-of-range dimensions rather than emitting them", () => {
    expect(mediaBoxStyle(1e9, 1e9)).toBe("");
    expect(mediaBoxStyle(-800, 600)).toBe("");
  });

  it("lets height bind for a tall image", () => {
    // 600x1200 at 14rem tall is 7rem wide, well inside the 20rem limit.
    expect(mediaBoxStyle(600, 1200)).toBe(
      "width: 7.000rem; aspect-ratio: 600 / 1200;"
    );
  });

  it("never enlarges a picture past its own size", () => {
    // The limits are a ceiling, not a target. A 64x64 avatar used to render
    // at 64; blowing it up to the 224px box just makes it blurry.
    expect(mediaBoxStyle(64, 64)).toBe(
      "width: 4.000rem; aspect-ratio: 64 / 64;"
    );
  });

  it("refuses a ratio absurd enough to be a sliver", () => {
    // Both numbers are inside the pixel bounds; the RATIO is the attack.
    expect(mediaBoxStyle(20000, 1)).toBe("");
    expect(mediaBoxStyle(1, 20000)).toBe("");
  });

  it("lets width bind for a wide image", () => {
    // 4000x1000 would want 56rem on height alone; the 20rem cap wins.
    expect(mediaBoxStyle(4000, 1000)).toBe(
      "width: 20.000rem; aspect-ratio: 4000 / 1000;"
    );
  });

  it("carries the true ratio, not a rounded one", () => {
    // The style is what stops the reflow, so the box has to match the image
    // exactly - a rounded ratio moves the content by a pixel or two on load.
    expect(mediaBoxStyle(1023, 767)).toContain("aspect-ratio: 1023 / 767;");
  });
});
