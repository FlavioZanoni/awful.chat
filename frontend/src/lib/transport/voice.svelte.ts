import { transportState } from "./transport.svelte";
import { loadAudioPrefs, saveAudioPrefs } from "./audio-prefs";
import type { LibP2PVoice } from "./libp2p/voice";
import type { DtlnProcessor } from "../audio/dtln-processor";

let _voice: LibP2PVoice | null = null;
let _dtln: DtlnProcessor | null = null;
let _initialized = false;

export function initVoice(voice: LibP2PVoice, dtln: DtlnProcessor): void {
  if (_initialized) return;
  _initialized = true;
  _voice = voice;
  _dtln = dtln;

  _voice.on("trackAdded", (peerId, track) => {
    const existing = transportState.participants.get(peerId) ?? {
      peerId,
      audioTrack: null,
      videoTrack: null,
      screenTrack: null,
      screenAudioTrack: null,
    };
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...existing,
        audioTrack: track,
      }
    );
  });

  _voice.on("trackRemoved", (peerId) => {
    const p = transportState.participants.get(peerId);
    if (!p) return;
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...p,
        audioTrack: null,
      }
    );
  });

  _voice.on("peerLeft", (peerId) => {
    const p = transportState.participants.get(peerId);
    if (!p) return;
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...p,
        audioTrack: null,
      }
    );
  });

  _voice.on("error", (err) => {
    transportState.error = err.message;
  });

  restoreVoicePrefs();
}

/**
 * Re-apply the settings from the last session. Safe to run before any call:
 * with no AudioContext yet these setters only record the preference, so
 * nothing here asks for microphone access.
 */
function restoreVoicePrefs(): void {
  const prefs = loadAudioPrefs();
  const voice = getVoice();
  voice.setInputGain(prefs.inputGain);
  voice.setOutputVolume(prefs.outputVolume);
  void voice.setDtlnEnabled(prefs.dtlnEnabled);
  getDtln().setNoiseGate(prefs.noiseGate);
  if (prefs.inputDevice) voice.setInputDevice(prefs.inputDevice);
  if (prefs.outputDevice) voice.setOutputDevice(prefs.outputDevice);
}

function getVoice(): LibP2PVoice {
  if (!_voice)
    throw new Error("Voice not initialized. Call initVoice() first.");
  return _voice;
}

function getDtln(): DtlnProcessor {
  if (!_dtln) throw new Error("DTLN not initialized. Call initVoice() first.");
  return _dtln;
}

export async function setVoiceInputDevice(deviceId: string): Promise<void> {
  saveAudioPrefs({ inputDevice: deviceId || null });
  await getVoice().setInputDevice(deviceId);
  transportState.localMicStream = getVoice().getMicStream();
}

export function getVoiceInputDevices(): Promise<MediaDeviceInfo[]> {
  return getVoice().getInputDevices();
}

export function getVoiceActiveInputDevice(): string | null {
  return getVoice().getActiveInputDevice();
}

export function setVoiceInputGain(gain: number): void {
  saveAudioPrefs({ inputGain: gain });
  getVoice().setInputGain(gain);
}
export function getVoiceInputGain(): number {
  return getVoice().getInputGain();
}

export async function setVoiceOutputDevice(deviceId: string): Promise<void> {
  saveAudioPrefs({ outputDevice: deviceId || null });
  await getVoice().setOutputDevice(deviceId);
}

export function getVoiceOutputDevices(): Promise<MediaDeviceInfo[]> {
  return getVoice().getOutputDevices();
}

export function getVoiceActiveOutputDevice(): string | null {
  return getVoice().getActiveOutputDevice();
}

export function setVoiceOutputVolume(volume: number): void {
  const next = Math.max(0, volume);
  saveAudioPrefs({ outputVolume: next });
  if (!transportState.deafened) getVoice().setOutputVolume(next);
}

export function getVoiceOutputVolume(): number {
  return getVoice().getOutputVolume();
}

export function setVoiceDtlnNoiseGate(threshold: number): void {
  saveAudioPrefs({ noiseGate: threshold });
  getDtln().setNoiseGate(threshold);
}

export function getVoiceDtlnNoiseGate(): number {
  return getDtln().getNoiseGate();
}

export async function setVoiceDtlnEnabled(enabled: boolean): Promise<void> {
  saveAudioPrefs({ dtlnEnabled: enabled });
  await getVoice().setDtlnEnabled(enabled);
  // Toggling this restarts the mic, so the old stream's tracks are stopped.
  // Anything still holding the previous stream (the speaking-ring analyser)
  // would read silence from a dead track for the rest of the call.
  transportState.localMicStream = getVoice().getMicStream();
}

export function getVoiceDtlnEnabled(): boolean {
  return getVoice().isDtlnEnabled();
}
