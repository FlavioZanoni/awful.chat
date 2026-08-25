import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "poll",
  name: "Poll",
  description: "Vote on options to see live results.",
  icon: "lucide:chart-column",
  author: "awful.chat",
  license: "MIT",
  version: "1.1.0",
  apiVersion: 1,
  commands: [{ name: "poll", usage: "/poll Question? Option A, Option B" }],
};
