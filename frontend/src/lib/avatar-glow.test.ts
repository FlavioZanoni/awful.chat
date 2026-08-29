import { describe, expect, it } from "vitest";
import {
  ambientStyle,
  averagePixels,
  rimStyle,
  stylize,
} from "./avatar-glow.svelte";

function px(r: number, g: number, b: number, a = 255) {
  return [r, g, b, a];
}

describe("averagePixels", () => {
  it("averages the opaque pixels", () => {
    const data = [...px(200, 100, 0), ...px(0, 100, 200)];
    expect(averagePixels(data)).toEqual([100, 100, 100]);
  });

  it("ignores transparent pixels rather than averaging in black", () => {
    // A circular avatar is a square PNG with transparent corners. Counting
    // those is counting black, and every glow comes out the same dead grey.
    const data = [...px(200, 40, 40), ...px(0, 0, 0, 0), ...px(0, 0, 0, 4)];
    expect(averagePixels(data)).toEqual([200, 40, 40]);
  });

  it("has no answer for a fully transparent image", () => {
    expect(averagePixels([...px(9, 9, 9, 0)])).toBeNull();
  });
});

describe("stylize", () => {
  it("recovers chroma the averaging washed out", () => {
    const [r, g, b] = stylize([140, 110, 110]).split(" ").map(Number);
    // The red lead over the other channels widens; it does not merely survive.
    expect(r - g).toBeGreaterThan(140 - 110);
    expect(g).toBe(b);
  });

  it("lifts a near-black average into something that reads as light", () => {
    const [r, g, b] = stylize([8, 8, 10]).split(" ").map(Number);
    expect(Math.max(r, g, b)).toBeGreaterThan(100);
  });

  it("pulls a near-white average back down so it is a colour, not a flare", () => {
    const [r, g, b] = stylize([250, 250, 252]).split(" ").map(Number);
    expect(Math.max(r, g, b)).toBeLessThan(230);
  });

  it("stays inside the byte range", () => {
    for (const c of [
      [255, 0, 0],
      [0, 0, 0],
      [255, 255, 255],
      [12, 200, 90],
    ] as Array<[number, number, number]>) {
      for (const v of stylize(c).split(" ").map(Number)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe("rimStyle", () => {
  it("is nothing at all when there is no colour", () => {
    expect(rimStyle(null)).toBe("");
    expect(rimStyle(undefined)).toBe("");
  });

  it("uses drop-shadow, never box-shadow", () => {
    // Tailwind builds ring-* out of box-shadow, so an inline box-shadow here
    // would silently delete the ring these avatars already wear.
    const style = rimStyle("10 20 30");
    expect(style).toContain("drop-shadow");
    expect(style).not.toContain("box-shadow");
    expect(style).toContain("rgb(10 20 30 / 0.35)");
  });

  it("scales down for a small avatar", () => {
    expect(rimStyle("1 2 3", 0.5)).toContain("0 0 4px");
  });
});

describe("ambientStyle", () => {
  it("is nothing at all when there is no colour", () => {
    expect(ambientStyle(null)).toBe("");
    expect(ambientStyle(undefined)).toBe("");
  });

  it("fills flat, with no gradient to band on a dark tile", () => {
    const style = ambientStyle("10 20 30");
    expect(style).toContain("background-color: rgb(10 20 30 / 0.7)");
    expect(style).not.toContain("gradient");
  });
});
