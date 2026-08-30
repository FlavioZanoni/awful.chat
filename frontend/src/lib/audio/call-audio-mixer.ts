const MAX_CALL_SOUND_SECONDS = 5;
/** Encoded-bytes ceiling, checked BEFORE decodeAudioData: decoding is where
 * an oversized blob turns into hundreds of MB of PCM, so the gate has to sit
 * in front of it. 2MB of compressed audio is far more than 5s ever needs. */
const MAX_CALL_SOUND_BYTES = 2 * 1024 * 1024;
/** Concurrent clips PER OWNER. This is a resource ceiling, not playback
 * policy - a plugin that wants one-at-a-time stops before it plays; this
 * only guarantees a looping bug cannot stack unbounded sources into the
 * call. Per owner, because a global cap would let one plugin's stacking
 * evict another plugin's clip - exactly the cross-plugin interference the
 * owner scoping exists to prevent. */
const MAX_CONCURRENT_SOUNDS_PER_OWNER = 5;

/** Host policy a caller can read instead of learning it from a README. */
export const CALL_SOUND_MAX_DURATION_MS = MAX_CALL_SOUND_SECONDS * 1000;

export interface CallSoundPlayback {
  id: string;
  durationMs: number;
}

interface ActiveSound {
  id: string;
  owner: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  monitorGain: GainNode;
}

/** Owns the one stable outgoing call track. Microphone rebuilds reconnect
 * behind it; intentional clips enter beside it.
 *
 * The microphone feeds the destination DIRECTLY - the limiter shapes only
 * the clips. Routing voice through the limiter changed how everyone sounded
 * all the time to protect against the few seconds a clip plays; a clip
 * already capped at -3dB on its own bus leaves the summed signal little
 * room to clip, and plain voice stays byte-for-byte what it was. */
export class CallAudioMixer {
  private destination: MediaStreamAudioDestinationNode;
  private limiter: DynamicsCompressorNode;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  /** Insertion-ordered: eviction takes the oldest. */
  private sounds = new Map<string, ActiveSound>();
  private sequence = 0;

  constructor(private context: AudioContext) {
    this.destination = context.createMediaStreamDestination();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.destination);
  }

  outputStream(): MediaStream {
    return this.destination.stream;
  }

  connectMicrophone(stream: MediaStream | null): void {
    this.microphoneSource?.disconnect();
    this.microphoneSource = null;
    if (!stream || stream.getAudioTracks().length === 0) return;
    this.microphoneSource = this.context.createMediaStreamSource(stream);
    this.microphoneSource.connect(this.destination);
  }

  async play(
    blob: Blob,
    options?: { volume?: number; owner?: string }
  ): Promise<CallSoundPlayback> {
    const volume = options?.volume ?? 1;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new Error("Sound volume must be between 0 and 1");
    }
    if (blob.size > MAX_CALL_SOUND_BYTES) {
      throw new Error("Sound file is too large for a call sound (2MB max)");
    }
    if (this.context.state === "suspended") await this.context.resume();
    const encoded = await blob.arrayBuffer();
    const buffer = await this.context.decodeAudioData(encoded.slice(0));
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error("Sound is empty");
    }
    if (buffer.duration > MAX_CALL_SOUND_SECONDS) {
      throw new Error("Sound exceeds the 5 second call limit");
    }

    const owner = options?.owner ?? "";
    // The map is insertion-ordered, so this owner's list is oldest-first.
    const owned = [...this.sounds.values()].filter((s) => s.owner === owner);
    const excess = owned.length - (MAX_CONCURRENT_SOUNDS_PER_OWNER - 1);
    for (const sound of owned.slice(0, Math.max(0, excess))) {
      this.stop(sound.id);
    }

    // Per-sound gain nodes, not shared ones: shared gains meant a new play
    // re-leveled whatever was still sounding, which is single-slot thinking.
    const gain = this.context.createGain();
    gain.gain.value = 0.8 * volume;
    gain.connect(this.limiter);
    const monitorGain = this.context.createGain();
    // Self-monitor at the SAME level peers receive. The original 0.18 was a
    // whisper - with a soundboard's 50% default volume it landed at 9% gain,
    // which read as "my sound did nothing". Echo is not the concern it looks
    // like: the mic runs with echo cancellation on, and AEC exists precisely
    // to subtract what the speakers are playing.
    monitorGain.gain.value = 0.8 * volume;
    monitorGain.connect(this.context.destination);

    const source = this.context.createBufferSource();
    const id = `call-sound-${Date.now()}-${this.sequence++}`;
    source.buffer = buffer;
    source.connect(gain);
    source.connect(monitorGain);
    source.onended = () => this.stop(id);
    this.sounds.set(id, {
      id,
      owner: options?.owner ?? "",
      source,
      gain,
      monitorGain,
    });
    source.start();
    return { id, durationMs: Math.round(buffer.duration * 1000) };
  }

  /** Stop one sound by id; with `owner` set, only if that owner started it. */
  stop(id: string, owner?: string): void {
    const sound = this.sounds.get(id);
    if (!sound || (owner !== undefined && sound.owner !== owner)) return;
    this.sounds.delete(id);
    sound.source.onended = null;
    try {
      sound.source.stop();
    } catch {}
    sound.source.disconnect();
    sound.gain.disconnect();
    sound.monitorGain.disconnect();
  }

  /** Stop every sound this owner started. */
  stopOwner(owner: string): void {
    for (const sound of [...this.sounds.values()]) {
      if (sound.owner === owner) this.stop(sound.id);
    }
  }

  /** Stop everything - the host's own lever (deafen, teardown). */
  stopAll(): void {
    for (const id of [...this.sounds.keys()]) this.stop(id);
  }

  dispose(): void {
    this.stopAll();
    this.microphoneSource?.disconnect();
    this.microphoneSource = null;
    this.limiter.disconnect();
  }
}
