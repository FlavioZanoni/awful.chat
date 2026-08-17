import { describe, it, expect } from "vitest";
import {
  MAX_GAIN,
  UNITY_STOP,
  formatGain,
  gainToSlider,
  sliderToGain,
} from "./volume-curve";

describe("volume curve", () => {
  it("has an exact 100% stop, which is the whole point of the split", () => {
    expect(sliderToGain(UNITY_STOP)).toBe(1);
    expect(formatGain(sliderToGain(UNITY_STOP))) .toBe("100%");
    expect(gainToSlider(1)).toBe(UNITY_STOP);
  });

  it("mutes at zero and tops out at 250%", () => {
    expect(sliderToGain(0)).toBe(0);
    expect(formatGain(sliderToGain(0))).toBe("muted");
    expect(sliderToGain(100)).toBeCloseTo(MAX_GAIN, 10);
    expect(formatGain(sliderToGain(100))).toBe("250%");
  });

  it("is monotonic across the whole range", () => {
    let prev = -1;
    for (let v = 0; v <= 100; v++) {
      const gain = sliderToGain(v);
      expect(gain).toBeGreaterThan(prev);
      prev = gain;
    }
  });

  it("is logarithmic: equal steps are equal ratios, not equal amounts", () => {
    // Within one segment, the ratio between neighbouring steps is constant.
    const r1 = sliderToGain(70) / sliderToGain(65);
    const r2 = sliderToGain(95) / sliderToGain(90);
    expect(r1).toBeCloseTo(r2, 6);
  });

  it("round-trips a gain back to its own slider position", () => {
    for (const gain of [0.01, 0.1, 0.5, 1, 1.5, 2.5]) {
      expect(sliderToGain(gainToSlider(gain))).toBeCloseTo(gain, 1);
    }
  });

  it("clamps out-of-range input instead of producing nonsense", () => {
    expect(sliderToGain(-5)).toBe(0);
    expect(sliderToGain(500)).toBeCloseTo(MAX_GAIN, 10);
    expect(gainToSlider(99)).toBe(100);
    expect(gainToSlider(-1)).toBe(0);
  });
});
