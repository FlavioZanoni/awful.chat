import { beforeEach, describe, expect, it } from "vitest";
import {
  allowSyncReaction,
  SYNC_REACTION_MIN_MS,
  _resetSyncThrottle,
} from "./sync-throttle";

beforeEach(() => _resetSyncThrottle());

describe("allowSyncReaction", () => {
  it("allows the first reaction and blocks repeats inside the window", () => {
    expect(allowSyncReaction("push|p|r", 1000)).toBe(true);
    expect(allowSyncReaction("push|p|r", 1000 + SYNC_REACTION_MIN_MS - 1)).toBe(
      false
    );
    expect(allowSyncReaction("push|p|r", 1000 + SYNC_REACTION_MIN_MS)).toBe(
      true
    );
  });

  it("a blocked attempt does not extend the window", () => {
    // The window measures from the last ALLOWED reaction: a peer hammering
    // frames must not push its own next allowance further away (or closer).
    allowSyncReaction("k", 1000);
    allowSyncReaction("k", 5000); // blocked
    expect(allowSyncReaction("k", 1000 + SYNC_REACTION_MIN_MS)).toBe(true);
  });

  it("scopes windows per key", () => {
    expect(allowSyncReaction("push|a|r", 1000)).toBe(true);
    expect(allowSyncReaction("push|b|r", 1000)).toBe(true);
    expect(allowSyncReaction("push|a|r2", 1000)).toBe(true);
    expect(allowSyncReaction("push|a|r", 1001)).toBe(false);
  });
});
