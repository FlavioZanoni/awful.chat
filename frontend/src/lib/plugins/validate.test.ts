import { describe, expect, it } from "vitest";
import {
  validatePluginId,
  validateCardPayload,
  validateUpdatePayload,
  validateEphemeralPayload,
} from "./validate";

describe("validatePluginId", () => {
  it("accepts valid plugin ids", () => {
    expect(validatePluginId("wheel").ok).toBe(true);
    expect(validatePluginId("poll").ok).toBe(true);
    expect(validatePluginId("my-plugin").ok).toBe(true);
    expect(validatePluginId("plugin123").ok).toBe(true);
  });

  it("rejects plugin ids that are too short", () => {
    expect(validatePluginId("a").ok).toBe(false);
  });

  it("rejects invalid plugin ids", () => {
    expect(validatePluginId("MyPlugin").ok).toBe(false); // uppercase
    expect(validatePluginId("my_plugin").ok).toBe(false); // underscore
    expect(validatePluginId("my plugin").ok).toBe(false); // space
    expect(validatePluginId("").ok).toBe(false); // empty
    expect(validatePluginId("a".repeat(33)).ok).toBe(false); // too long
  });

  it("rejects non-string input", () => {
    expect(validatePluginId(123 as unknown).ok).toBe(false);
    expect(validatePluginId(null as unknown).ok).toBe(false);
    expect(validatePluginId(undefined as unknown).ok).toBe(false);
  });
});

describe("validateCardPayload", () => {
  it("accepts small payloads", () => {
    expect(validateCardPayload({ data: "test" })).toEqual({ ok: true });
    expect(validateCardPayload({ options: ["a", "b"] })).toEqual({ ok: true });
  });

  it("rejects payloads over 16KB", () => {
    const large = { data: "x".repeat(17 * 1024) };
    const result = validateCardPayload(large);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeds 16 KB");
  });

  it("rejects non-serializable data", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const result = validateCardPayload(circular);
    expect(result.ok).toBe(false);
  });
});

describe("validateUpdatePayload", () => {
  it("accepts small payloads", () => {
    expect(validateUpdatePayload({ vote: 0 })).toEqual({ ok: true });
    expect(validateUpdatePayload({ action: "spin" })).toEqual({ ok: true });
  });

  it("rejects payloads over 4KB", () => {
    const large = { data: "x".repeat(5 * 1024) };
    const result = validateUpdatePayload(large);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeds 4 KB");
  });
});

describe("validateEphemeralPayload", () => {
  it("accepts small payloads", () => {
    expect(validateEphemeralPayload({ cursor: { x: 100, y: 200 } })).toEqual({
      ok: true,
    });
  });

  it("rejects payloads over 4KB", () => {
    const large = { data: "x".repeat(5 * 1024) };
    const result = validateEphemeralPayload(large);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeds 4 KB");
  });
});
