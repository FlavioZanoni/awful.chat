/**
 * Name effect utilities for applying text effects to user nicknames.
 * CSS-only animations, respecting prefers-reduced-motion.
 */

export type NameEffect = "none" | "gradient" | "shimmer" | "glow" | "rainbow";

/**
 * Generate class and inline style for a name effect.
 * Returns an object with `class` and `style` properties.
 */
export function nameEffectStyle(
  effect: string | undefined,
  color: string | undefined
): { class: string; style: string } {
  if (!effect || effect === "none" || !color) {
    return { class: "", style: "" };
  }

  const baseClass = "name-effect";

  switch (effect) {
    case "gradient": {
      // Static two-color gradient: color -> lighter complementary
      const lighter = lightenColor(color);
      return {
        class: `${baseClass} name-effect-gradient`,
        style: `background: linear-gradient(90deg, ${color}, ${lighter}); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;`,
      };
    }

    case "shimmer": {
      // Animated gradient sweep
      return {
        class: `${baseClass} name-effect-shimmer`,
        style: `background: linear-gradient(90deg, ${color}, rgba(255,255,255,0.3), ${color}); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: shimmer 2s infinite;`,
      };
    }

    case "glow": {
      // Text-shadow pulse in the nickname color
      return {
        class: `${baseClass} name-effect-glow`,
        style: `color: ${color}; text-shadow: 0 0 8px ${color}; animation: glow 2s ease-in-out infinite;`,
      };
    }

    case "rainbow": {
      // Animated hue-rotate
      return {
        class: `${baseClass} name-effect-rainbow`,
        style: `animation: rainbow 3s linear infinite;`,
      };
    }

    default:
      return { class: "", style: "" };
  }
}

/**
 * Generate a lighter/complementary color from a hex color.
 * Simple approach: desaturate and brighten.
 */
function lightenColor(hex: string): string {
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  // Lighten by averaging with white and boosting saturation
  const lr = Math.min(255, Math.floor(r * 0.7 + 255 * 0.3));
  const lg = Math.min(255, Math.floor(g * 0.7 + 255 * 0.3));
  const lb = Math.min(255, Math.floor(b * 0.7 + 255 * 0.3));

  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}
