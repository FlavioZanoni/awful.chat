import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "poll",
  name: "Poll",
  description: "Vote on options to see live results.",
  icon: "lucide:chart-column",
  author: "awful.chat",
  license: "Apache-2.0",
  version: "1.1.0",
  repository: "https://github.com/awful-org/awful.chat/tree/main/frontend/plugins/poll",
  apiVersion: 1,
  commands: [{ name: "poll", usage: "/poll Question? Option A, Option B" }],
};
