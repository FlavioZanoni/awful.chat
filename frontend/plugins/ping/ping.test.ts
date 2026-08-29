import { describe, expect, it } from "vitest";
import {
  BASE_INTERVAL_MS,
  chartCeiling,
  nextInterval,
  parsePingArgs,
  PROBE_TIMEOUT_MS,
  summarize,
  packSeries,
  unpackSeries,
  MAX_PUBLISHED_POINTS,
  MAX_TARGETS,
} from "./logic";

describe("nextInterval", () => {
  it("holds the base cadence while the link is fast", () => {
    // 2 x 20ms is well under the base, so there is no reason to hurry.
    expect(nextInterval(20)).toBe(BASE_INTERVAL_MS);
  });

  it("backs off once the round trip approaches the cadence", () => {
    // Probing every 500ms when a reply takes 400ms puts two on the wire at
    // once and measures our own queue.
    expect(nextInterval(400)).toBe(800);
  });

  it("treats loss as the worst case", () => {
    expect(nextInterval(null)).toBeGreaterThan(BASE_INTERVAL_MS);
    expect(nextInterval(null)).toBeLessThanOrEqual(PROBE_TIMEOUT_MS);
  });
});

describe("summarize", () => {
  const at = (rtt: number | null, i: number) => ({ at: i * 500, rtt });

  it("reports nothing rather than zero for an empty run", () => {
    expect(summarize([])).toEqual({
      min: null,
      median: null,
      max: null,
      loss: 0,
      sent: 0,
    });
  });

  it("takes the middle value, not the average", () => {
    // The point of the median: four fast replies and one 900ms spike. A mean
    // would report ~200ms and hide the spike entirely.
    const s = summarize([10, 12, 14, 16, 900].map(at));
    expect(s.median).toBe(14);
    expect(s.max).toBe(900);
    expect(s.min).toBe(10);
  });

  it("averages the two middle values on an even count", () => {
    expect(summarize([10, 20, 30, 40].map(at)).median).toBe(25);
  });

  it("counts a lost probe as loss, never as latency", () => {
    // Folding a timeout in as a number would drag the median and blow out
    // the scale of anything plotting it.
    const s = summarize([10, null, 20, null].map(at));
    expect(s.loss).toBe(0.5);
    expect(s.max).toBe(20);
    expect(s.sent).toBe(4);
  });

  it("survives a run where nothing came back", () => {
    const s = summarize([null, null].map(at));
    expect(s).toEqual({
      min: null,
      median: null,
      max: null,
      loss: 1,
      sent: 2,
    });
  });
});

describe("parsePingArgs", () => {
  it("takes names with or without the @", () => {
    expect(parsePingArgs("@alice, bob")).toEqual(["alice", "bob"]);
  });

  it("accepts spaces as well as commas", () => {
    expect(parsePingArgs("@alice @bob")).toEqual(["alice", "bob"]);
  });

  it("drops duplicates rather than pinging someone twice", () => {
    expect(parsePingArgs("@alice, @alice")).toEqual(["alice"]);
  });

  it("caps the target count", () => {
    expect(parsePingArgs("a, b, c, d, e")).toHaveLength(MAX_TARGETS);
  });

  it("is empty for empty input", () => {
    expect(parsePingArgs("   ")).toEqual([]);
    expect(parsePingArgs(",,,")).toEqual([]);
  });
});

describe("chartCeiling", () => {
  it("never returns zero, so a perfect run still has a scale", () => {
    expect(chartCeiling([])).toBeGreaterThan(0);
    expect(chartCeiling([{ at: 0, rtt: null }])).toBeGreaterThan(0);
  });

  it("rounds up to a readable step", () => {
    expect(chartCeiling([{ at: 0, rtt: 42 }])).toBe(50);
    expect(chartCeiling([{ at: 0, rtt: 260 }])).toBe(300);
  });

  it("is set by the worst ANSWERED probe", () => {
    // A lost probe has no height; letting it near the scale would be
    // inventing a number.
    expect(chartCeiling([{ at: 0, rtt: 42 }, { at: 1, rtt: null }])).toBe(50);
  });
});

describe("packSeries / unpackSeries", () => {
  const run = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ at: i * 500.4, rtt: 20.6 + i }));

  it("round-trips a short run unchanged apart from rounding", () => {
    const packed = packSeries(run(3));
    expect(packed).toEqual([
      [0, 21],
      [500, 22],
      [1001, 23],
    ]);
    expect(unpackSeries(packed)).toEqual([
      { at: 0, rtt: 21 },
      { at: 500, rtt: 22 },
      { at: 1001, rtt: 23 },
    ]);
  });

  it("keeps loss as loss through the round trip", () => {
    const packed = packSeries([{ at: 0, rtt: null }]);
    expect(packed).toEqual([[0, null]]);
    expect(unpackSeries(packed)).toEqual([{ at: 0, rtt: null }]);
  });

  it("thins a long run down to the cap", () => {
    expect(packSeries(run(500)).length).toBeLessThanOrEqual(
      MAX_PUBLISHED_POINTS
    );
  });

  it("fits three peers of a full run inside the 4KB update cap", () => {
    // The cap is the reason this is packed at all; a test that does not
    // check it is not checking the thing that matters.
    const three = {
      a: packSeries(run(60)),
      b: packSeries(run(60)),
      c: packSeries(run(60)),
    };
    expect(JSON.stringify(three).length).toBeLessThan(4096);
  });

  it("drops garbage rather than trusting a peer's array", () => {
    expect(
      unpackSeries([[0, 10], "nope", [1], [2, "x"], [-1, 5], [3, 12]])
    ).toEqual([
      { at: 0, rtt: 10 },
      { at: 3, rtt: 12 },
    ]);
  });

  it("is empty for anything that is not an array", () => {
    expect(unpackSeries(null)).toEqual([]);
    expect(unpackSeries({ 0: [1, 2] })).toEqual([]);
  });
});
