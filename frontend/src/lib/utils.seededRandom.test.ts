import { describe, expect, it } from "vitest";
import { seededRandom } from "./utils";

describe("seededRandom", () => {
  it("produces deterministic sequences", () => {
    const rng1 = seededRandom("test-seed");
    const values1 = [rng1(), rng1(), rng1(), rng1(), rng1()];

    const rng2 = seededRandom("test-seed");
    const values2 = [rng2(), rng2(), rng2(), rng2(), rng2()];

    expect(values1).toEqual(values2);
  });

  it("produces different sequences for different seeds", () => {
    const rng1 = seededRandom("seed1");
    const values1 = [rng1(), rng1(), rng1()];

    const rng2 = seededRandom("seed2");
    const values2 = [rng2(), rng2(), rng2()];

    expect(values1).not.toEqual(values2);
  });

  it("produces values in range [0, 1)", () => {
    const rng = seededRandom("test");
    for (let i = 0; i < 100; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("produces repeatable sequences with same seed", () => {
    const rng1 = seededRandom("fixed-vector-1");
    const values1 = [rng1(), rng1(), rng1()];

    const rng2 = seededRandom("fixed-vector-1");
    const values2 = [rng2(), rng2(), rng2()];

    expect(values1).toEqual(values2);
  });
});
