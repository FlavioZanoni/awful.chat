/**
 * Slider position <-> gain, logarithmically: equal distance on the slider is
 * an equal ratio in volume, which is how loudness is actually perceived.
 *
 * The curve is split at a fixed stop so 100% is an exact position the user can
 * land on again. A single continuous log curve puts unity gain between two
 * integer steps - the output slider in audio settings shows "102%" at rest for
 * exactly that reason.
 */

/** Slider position that means "unchanged". */
export const UNITY_STOP = 60;
export const MIN_GAIN = 0.01;
export const MAX_GAIN = 2.5;

/** 0 is silent, 1..UNITY_STOP spans MIN_GAIN..1, above it spans 1..MAX_GAIN. */
export function sliderToGain(slider: number): number {
  const v = Math.max(0, Math.min(100, slider));
  if (v <= 0) return 0;
  if (v <= UNITY_STOP) {
    const t = (v - 1) / (UNITY_STOP - 1);
    return Math.pow(10, Math.log10(MIN_GAIN) * (1 - t));
  }
  const t = (v - UNITY_STOP) / (100 - UNITY_STOP);
  return Math.pow(10, Math.log10(MAX_GAIN) * t);
}

export function gainToSlider(gain: number): number {
  if (gain <= 0) return 0;
  if (gain >= 1) {
    const t = Math.log10(Math.min(gain, MAX_GAIN)) / Math.log10(MAX_GAIN);
    return Math.round(UNITY_STOP + t * (100 - UNITY_STOP));
  }
  const t = 1 - Math.log10(Math.max(gain, MIN_GAIN)) / Math.log10(MIN_GAIN);
  return Math.round(1 + t * (UNITY_STOP - 1));
}

export function formatGain(gain: number): string {
  return gain <= 0 ? "muted" : `${Math.round(gain * 100)}%`;
}
