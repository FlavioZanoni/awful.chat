export interface DtlnMessage {
  output_gain?: number;
  noise_gate?: number;
}

export class DtlnProcessor {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ready = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private initializing = false;

  // Two independent graphs share the single DTLN worklet node:
  //
  //   transport: mic -> txInputGain -> worklet -> txOutputGain -> dest (peers)
  //   monitor:   mic -> monGain     -> worklet -> dest (your speakers)
  //
  // They are tracked separately so a mic test can never tear down the audio
  // path of a live call (and vice versa).
  private txSource: MediaStreamAudioSourceNode | null = null;
  private txInputGain: GainNode | null = null;
  private txOutputGain: GainNode | null = null;
  private transportDest: MediaStreamAudioDestinationNode | null = null;

  private monSource: MediaStreamAudioSourceNode | null = null;
  private monGain: GainNode | null = null;
  private monDest: MediaStreamAudioDestinationNode | null = null;

  constructor() {
    this.readyPromise = new Promise((r) => (this.resolveReady = r));
    console.log("DtlnProcessor created");
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initializing) return this.readyPromise;
    this.initializing = true;

    // Create context (it will start 'suspended' if no user gesture)
    this.audioCtx = new AudioContext({ sampleRate: 16000 });

    await this.audioCtx.audioWorklet.addModule("/audio-worklet.js");

    this.workletNode = new AudioWorkletNode(
      this.audioCtx,
      "NoiseSuppressionWorker",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("DTLN ready timeout")),
        15000
      );

      this.workletNode!.port.onmessage = (event) => {
        if (event.data === "ready") {
          clearTimeout(timeout);
          this.workletNode!.port.onmessage = (e) =>
            this.handleWorkletMessage(e);
          resolve();
        }
      };
    });

    this.ready = true;
    this.resolveReady();
  }

  private handleWorkletMessage(_: MessageEvent): void {
    //console.log("Message from DTLN worklet:", event.data);
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  get ctx(): AudioContext {
    if (!this.audioCtx) throw new Error("DtlnProcessor not initialized");
    return this.audioCtx;
  }

  get node(): AudioWorkletNode {
    if (!this.workletNode) throw new Error("DtlnProcessor not initialized");
    return this.workletNode;
  }

  setGain(gain: number): void {
    this.workletNode?.port.postMessage({ output_gain: gain });
  }

  setNoiseGate(threshold: number): void {
    this.workletNode?.port.postMessage({ noise_gate: threshold });
  }

  // connect a mic stream through DTLN, returns the processed MediaStream
  async processStream(
    micStream: MediaStream,
    inputGain = 1.0
  ): Promise<MediaStream> {
    await this.waitUntilReady();
    const ctx = this.ctx;
    // without user gesture it will start suspended
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    // Replace only the previous transport graph - a running mic test keeps its own.
    this.releaseTransport();

    const source = ctx.createMediaStreamSource(micStream);
    const inputGainNode = ctx.createGain();
    const outputGainNode = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();

    // Set initial gain values
    inputGainNode.gain.value = inputGain;
    // Boost output to compensate for DTLN attenuation
    outputGainNode.gain.value = 3.0;

    source.connect(inputGainNode);
    inputGainNode.connect(this.node);
    this.node.connect(outputGainNode);
    // If a mic test is monitoring right now, leave the peer-facing edge cut:
    // the test's cleanup reconnects it, so rebuilding the mic mid-test does
    // not start broadcasting the test to the call.
    if (!this.monDest) outputGainNode.connect(dest);

    this.txSource = source;
    this.txInputGain = inputGainNode;
    this.txOutputGain = outputGainNode;
    this.transportDest = dest;
    return dest.stream;
  }

  /**
   * Tear the peer-facing graph down entirely. Call when rebuilding the mic,
   * when DTLN is switched off, or when a call ends, so the worklet stops
   * chewing CPU on a dead mic.
   */
  releaseTransport(): void {
    this.txSource?.disconnect();
    this.txInputGain?.disconnect();
    this.txOutputGain?.disconnect();
    if (this.txOutputGain && this.workletNode) {
      try {
        this.workletNode.disconnect(this.txOutputGain);
      } catch {}
    }
    this.txSource = null;
    this.txInputGain = null;
    this.txOutputGain = null;
    this.transportDest = null;
  }

  /**
   * Temporarily stop feeding peers without dismantling the graph, so a mic
   * test is not broadcast to everyone in the call. The cut is made at
   * outputGain -> dest, which is the edge that actually exists.
   */
  disconnectFromTransport(): void {
    if (!this.txOutputGain || !this.transportDest) return;
    try {
      this.txOutputGain.disconnect(this.transportDest);
    } catch {}
  }

  reconnectToTransport(): void {
    if (!this.txOutputGain || !this.transportDest) return;
    try {
      this.txOutputGain.connect(this.transportDest);
    } catch {}
  }

  // for mic test - connect to speakers directly so user can hear themselves
  async monitorStream(
    micStream: MediaStream
  ): Promise<{ processedStream: MediaStream; cleanup: () => void }> {
    await this.waitUntilReady();
    const ctx = this.ctx;
    if (ctx.state === "suspended") await ctx.resume();

    // Replace only a previous monitor graph - never touch the call's path.
    this.releaseMonitor();

    const source = ctx.createMediaStreamSource(micStream);
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(this.node);
    this.node.connect(dest);

    this.monSource = source;
    this.monGain = gain;
    this.monDest = dest;

    return {
      processedStream: dest.stream,
      cleanup: () => this.releaseMonitor(),
    };
  }

  private releaseMonitor(): void {
    this.monSource?.disconnect();
    this.monGain?.disconnect();
    if (this.monDest && this.workletNode) {
      try {
        this.workletNode.disconnect(this.monDest);
      } catch {}
    }
    this.monSource = null;
    this.monGain = null;
    this.monDest = null;
  }
}
