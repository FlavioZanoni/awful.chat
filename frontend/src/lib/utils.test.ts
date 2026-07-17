import { describe, expect, it } from "vitest";
import { decode, encode, hex, normalizeAvatarUrl, unhex } from "./utils";

describe("hex codec", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(unhex(hex(bytes))).toEqual(bytes);
  });

  it("throws on odd-length input", () => {
    expect(() => unhex("abc")).toThrow();
  });
});

describe("json wire codec", () => {
  it("round-trips objects", () => {
    const obj = { a: 1, b: "two", c: [3] };
    expect(decode(encode(obj))).toEqual(obj);
  });
});

describe("normalizeAvatarUrl", () => {
  it("accepts http(s) urls", () => {
    expect(normalizeAvatarUrl("https://x.test/a.png")).toBe(
      "https://x.test/a.png"
    );
  });

  it("rejects javascript: and data: urls", () => {
    expect(normalizeAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeAvatarUrl("data:text/html,<script>")).toBeUndefined();
  });

  it("rejects non-strings and garbage", () => {
    expect(normalizeAvatarUrl(42)).toBeUndefined();
    expect(normalizeAvatarUrl("not a url")).toBeUndefined();
  });
});
