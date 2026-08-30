import { describe, expect, it } from "vitest";
import { HAS_IMAGE, HAS_LINK } from "./engine";
import { isEmptyQuery, parseSearchQuery } from "./query";

const NOW = new Date(2026, 7, 30, 15, 0, 0).getTime();

describe("parseSearchQuery", () => {
  it("bare tokens become lowercased fuzzy terms", () => {
    const q = parseSearchQuery("Hello World");
    expect(q.terms).toEqual([
      { text: "hello", exact: false },
      { text: "world", exact: false },
    ]);
  });

  it("quoted phrases become exact terms", () => {
    const q = parseSearchQuery('"exact phrase" loose');
    expect(q.terms).toEqual([
      { text: "exact phrase", exact: true },
      { text: "loose", exact: false },
    ]);
  });

  it("parses filters out of the term list", () => {
    const q = parseSearchQuery("from:alice in:dev has:image has:link report");
    expect(q.from).toBe("alice");
    expect(q.inRoom).toBe("dev");
    expect(q.has).toBe(HAS_IMAGE | HAS_LINK);
    expect(q.terms).toEqual([{ text: "report", exact: false }]);
  });

  it("parses date bounds with sugar", () => {
    const q = parseSearchQuery("after:yesterday before:2026-08-30", NOW);
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = new Date(2026, 7, 30).getTime();
    expect(q.after).toBe(todayStart - dayMs);
    expect(q.before).toBe(todayStart);
  });

  it("unknown filters and bad dates degrade to plain terms", () => {
    const q = parseSearchQuery("wat:ever before:notadate");
    expect(q.terms.map((t) => t.text)).toEqual(["wat:ever", "before:notadate"]);
    expect(q.before).toBeNull();
  });

  it("isEmptyQuery is true only with nothing set", () => {
    expect(isEmptyQuery(parseSearchQuery(""))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery("  "))).toBe(true);
    expect(isEmptyQuery(parseSearchQuery("has:image"))).toBe(false);
    expect(isEmptyQuery(parseSearchQuery("x"))).toBe(false);
  });
});
