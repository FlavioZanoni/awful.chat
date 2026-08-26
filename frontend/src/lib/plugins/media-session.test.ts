import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNowPlayingFor, type NowPlayingInfo } from "./media-session";

// A minimal navigator.mediaSession double: records what the host applies so
// the arbitration rules (latest claimer wins, only the owner can release)
// are observable.
interface FakeSession {
  metadata: unknown;
  playbackState: string;
  handlers: Map<string, (() => void) | null>;
}

function makeSession(): FakeSession {
  const s: FakeSession = {
    metadata: null,
    playbackState: "none",
    handlers: new Map(),
  };
  (s as unknown as Record<string, unknown>).setActionHandler = (
    action: string,
    fn: (() => void) | null
  ) => s.handlers.set(action, fn);
  return s;
}

class FakeMediaMetadata {
  title: string;
  constructor(init: { title: string }) {
    this.title = init.title;
  }
}

let session: FakeSession;

beforeEach(() => {
  session = makeSession();
  vi.stubGlobal("navigator", { mediaSession: session });
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function info(title: string, extra?: Partial<NowPlayingInfo>): NowPlayingInfo {
  return { title, playing: true, ...extra };
}

describe("setNowPlayingFor arbitration", () => {
  it("applies the claimer's metadata and handlers", () => {
    const onPlay = vi.fn();
    setNowPlayingFor(Symbol("a"), info("Song A", { onPlay, playing: false }));
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song A");
    expect(session.playbackState).toBe("paused");
    session.handlers.get("play")?.();
    expect(onPlay).toHaveBeenCalledOnce();
    // No next-track handler was given, so none must be bound.
    expect(session.handlers.get("nexttrack")).toBeNull();
  });

  it("latest claimer wins", () => {
    setNowPlayingFor(Symbol("a"), info("Song A"));
    setNowPlayingFor(Symbol("b"), info("Song B"));
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song B");
  });

  it("a stale claimer's release does not clobber the current owner", () => {
    const a = Symbol("a");
    setNowPlayingFor(a, info("Song A"));
    setNowPlayingFor(Symbol("b"), info("Song B"));
    setNowPlayingFor(a, null);
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song B");
    expect(session.playbackState).toBe("playing");
  });

  it("the owner's release clears the surface", () => {
    const a = Symbol("a");
    setNowPlayingFor(a, info("Song A"));
    setNowPlayingFor(a, null);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(session.handlers.get("play")).toBeNull();
  });

  it("releasing when never claimed is a no-op", () => {
    setNowPlayingFor(Symbol("b"), info("Song B"));
    setNowPlayingFor(Symbol("never"), null);
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song B");
  });

  it("survives a missing mediaSession", () => {
    vi.stubGlobal("navigator", {});
    expect(() => setNowPlayingFor(Symbol("a"), info("Song A"))).not.toThrow();
  });
});
