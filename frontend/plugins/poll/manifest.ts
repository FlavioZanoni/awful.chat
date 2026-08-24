import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "poll",
  name: "Poll",
  description: "Vote on options to see live results.",
  icon: "📊",
  author: "awful.chat",
  license: "MIT",
  apiVersion: 1,
  commands: [{ name: "poll", usage: "/poll Question? Option A, Option B" }],
};
