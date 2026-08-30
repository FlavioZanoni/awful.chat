import { describe, expect, it, vi } from "vitest";
import { CallAudioMixer } from "./call-audio-mixer";

class NodeMock {
  connections: unknown[] = [];
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect(node: unknown) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.connections = [];
  }
}

class SourceMock extends NodeMock {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

function context(duration = 1) {
  const destination = new NodeMock() as NodeMock & { stream: MediaStream };
  destination.stream = {
    getAudioTracks: () => [{ id: "stable" }],
  } as unknown as MediaStream;
  const sources: SourceMock[] = [];
  const gains: NodeMock[] = [];
  const micSources: NodeMock[] = [];
  const ctx = {
    state: "running",
    destination: new NodeMock(),
    createMediaStreamDestination: () => destination,
    createDynamicsCompressor: () => new NodeMock(),
    createGain: () => {
      const gain = new NodeMock();
      gains.push(gain);
      return gain;
    },
    createMediaStreamSource: () => {
      const source = new NodeMock();
      micSources.push(source);
      return source;
    },
    createBufferSource: () => {
      const source = new SourceMock();
      sources.push(source);
      return source;
    },
    decodeAudioData: vi.fn(async () => ({ duration })),
    resume: vi.fn(async () => undefined),
  } as unknown as AudioContext;
  return { ctx, sources, gains, micSources, destination };
}

describe("CallAudioMixer", () => {
  it("keeps one stable output stream while microphone inputs change", () => {
    const { ctx } = context();
    const mixer = new CallAudioMixer(ctx);
    const stable = mixer.outputStream();
    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream;
    mixer.connectMicrophone(stream);
    mixer.connectMicrophone(stream);
    expect(mixer.outputStream()).toBe(stable);
  });

  it("feeds the microphone to the destination without the limiter", () => {
    // The limiter shapes only the clips: routing voice through it changed
    // how everyone sounded all the time to protect a few seconds of clip.
    const { ctx, micSources, destination } = context();
    const mixer = new CallAudioMixer(ctx);
    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream;
    mixer.connectMicrophone(stream);
    expect(micSources[0].connections).toEqual([destination]);
  });

  it("layers concurrent clips instead of stopping the previous one", async () => {
    const { ctx, sources } = context(2.5);
    const mixer = new CallAudioMixer(ctx);
    const blob = new Blob([new Uint8Array([1])]);
    const first = await mixer.play(blob);
    const second = await mixer.play(blob);
    expect(first.durationMs).toBe(2500);
    expect(second.id).not.toBe(first.id);
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(sources[1].start).toHaveBeenCalledOnce();
  });

  it("evicts the owner's own oldest clip past the concurrency cap", async () => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    for (let i = 0; i < 5; i++)
      await mixer.play(new Blob(["x"]), { owner: "soundboard" });
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[1].stop).not.toHaveBeenCalled();
    expect(sources[4].start).toHaveBeenCalledOnce();
  });

  it("never evicts another owner's clip to make room", async () => {
    // The cap is a per-owner resource ceiling: one plugin stacking clips
    // must not silence a sound a different plugin is playing.
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    await mixer.play(new Blob(["x"]), { owner: "tts" });
    for (let i = 0; i < 5; i++)
      await mixer.play(new Blob(["x"]), { owner: "soundboard" });
    // tts's clip (sources[0]) survives; soundboard evicted its own oldest.
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(sources[1].stop).toHaveBeenCalledOnce();
  });

  it("scopes stop to the owner that started the sound", async () => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    const mine = await mixer.play(new Blob(["x"]), { owner: "soundboard" });
    const theirs = await mixer.play(new Blob(["x"]), { owner: "tts" });

    // Wrong owner: refused.
    mixer.stop(theirs.id, "soundboard");
    expect(sources[1].stop).not.toHaveBeenCalled();

    // Right owner by id, and everything of one owner.
    mixer.stop(mine.id, "soundboard");
    expect(sources[0].stop).toHaveBeenCalledOnce();
    mixer.stopOwner("tts");
    expect(sources[1].stop).toHaveBeenCalledOnce();
  });

  it("gives each clip its own volume without re-leveling the others", async () => {
    const { ctx, gains } = context();
    const mixer = new CallAudioMixer(ctx);
    await mixer.play(new Blob(["x"]), { volume: 1 });
    await mixer.play(new Blob(["x"]), { volume: 0.25 });
    // Per play: [gain, monitorGain]. The first clip's levels are untouched.
    expect(gains[0].gain.value).toBe(0.8);
    expect(gains[1].gain.value).toBe(0.18);
    expect(gains[2].gain.value).toBe(0.2);
    expect(gains[3].gain.value).toBe(0.045);
  });

  it.each([-0.01, 1.01, Number.NaN])("rejects invalid volume %s", async (volume) => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    await expect(mixer.play(new Blob(["x"]), { volume })).rejects.toThrow(
      "between 0 and 1"
    );
    expect(sources).toHaveLength(0);
  });

  it("rejects an oversized blob before decoding it", async () => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    const big = { size: 2 * 1024 * 1024 + 1 } as Blob;
    await expect(mixer.play(big)).rejects.toThrow("too large");
    expect(
      (ctx.decodeAudioData as unknown as { mock: { calls: unknown[] } }).mock
        .calls
    ).toHaveLength(0);
    expect(sources).toHaveLength(0);
  });

  it("accepts a clip exactly five seconds long", async () => {
    const { ctx, sources } = context(5);
    const mixer = new CallAudioMixer(ctx);
    await expect(mixer.play(new Blob(["x"]))).resolves.toMatchObject({
      durationMs: 5000,
    });
    expect(sources).toHaveLength(1);
  });

  it("rejects decoded clips even one millisecond over five seconds", async () => {
    const { ctx, sources } = context(5.001);
    const mixer = new CallAudioMixer(ctx);
    await expect(mixer.play(new Blob(["x"]))).rejects.toThrow("5 second");
    expect(sources).toHaveLength(0);
  });

  it("stops every active clip on dispose", async () => {
    const { ctx, sources } = context();
    const mixer = new CallAudioMixer(ctx);
    await mixer.play(new Blob(["x"]));
    await mixer.play(new Blob(["y"]));
    mixer.dispose();
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[1].stop).toHaveBeenCalledOnce();
  });
});
