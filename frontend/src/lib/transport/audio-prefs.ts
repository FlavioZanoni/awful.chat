/**
 * Audio settings survive a reload. They live in localStorage rather than
 * IndexedDB because they belong to the device, not the identity: the mic you
 * picked on this machine should not follow you to another one through sync.
 */

const KEY = "awful_audio_prefs";

export interface AudioPrefs {
  inputDevice: string | null;
  outputDevice: string | null;
  inputGain: number;
  outputVolume: number;
  dtlnEnabled: boolean;
  noiseGate: number;
}

export const AUDIO_PREF_DEFAULTS: AudioPrefs = {
  inputDevice: null,
  outputDevice: null,
  inputGain: 1.0,
  outputVolume: 1.0,
  dtlnEnabled: true,
  noiseGate: 0.002,
};

function num(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

export function loadAudioPrefs(): AudioPrefs {
  if (typeof localStorage === "undefined") return { ...AUDIO_PREF_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...AUDIO_PREF_DEFAULTS };
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      inputDevice: typeof p.inputDevice === "string" ? p.inputDevice : null,
      outputDevice: typeof p.outputDevice === "string" ? p.outputDevice : null,
      inputGain: num(p.inputGain, AUDIO_PREF_DEFAULTS.inputGain, 0, 2.5),
      outputVolume: num(p.outputVolume, AUDIO_PREF_DEFAULTS.outputVolume, 0, 2),
      dtlnEnabled:
        typeof p.dtlnEnabled === "boolean"
          ? p.dtlnEnabled
          : AUDIO_PREF_DEFAULTS.dtlnEnabled,
      noiseGate: num(p.noiseGate, AUDIO_PREF_DEFAULTS.noiseGate, 0, 0.01),
    };
  } catch {
    return { ...AUDIO_PREF_DEFAULTS };
  }
}

export function saveAudioPrefs(patch: Partial<AudioPrefs>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadAudioPrefs(), ...patch }));
  } catch {
    // Storage full or blocked: settings just do not persist this time.
  }
}
