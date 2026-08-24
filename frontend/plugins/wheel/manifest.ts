import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "wheel",
  name: "Wheel decide",
  description: "Spin a wheel to settle what to play.",
  icon: "🎡",
  apiVersion: 1,
  commands: [{ name: "wheel", usage: "/wheel option1, option2, ..." }],
};
