import { describe, expect, it } from "vitest";
import { formatRoomCode, newRoomCode, normalizeRoomCode } from "./room-code";

describe("room codes", () => {
  it("is 13 Crockford base32 characters (65 bits)", () => {
    for (let i = 0; i < 50; i++) {
      expect(newRoomCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{13}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newRoomCode()));
    expect(seen.size).toBe(500);
  });

  it("formats for reading aloud and normalizes what was read", () => {
    const code = "6BMB3GST2JRJZ";
    expect(formatRoomCode(code)).toBe("6BMB-3GST-2JRJ-Z");
    expect(normalizeRoomCode(" 6bmb-3gst-2jrj-z ")).toBe(code);
    expect(normalizeRoomCode("6BMB 3GST 2JRJ Z")).toBe(code);
    // O for 0, l/I for 1
    expect(normalizeRoomCode("OBMB-3GST-2JRJ-l")).toBe("0BMB3GST2JRJ1");
  });

  it("leaves legacy hex codes and short invites untouched", () => {
    expect(normalizeRoomCode("3f9a1c2b4d5e6f70")).toBe("3f9a1c2b4d5e6f70");
    expect(normalizeRoomCode("a1b2c3")).toBe("a1b2c3");
    expect(formatRoomCode("3f9a1c2b4d5e6f70")).toBe("3f9a1c2b4d5e6f70");
  });
});
