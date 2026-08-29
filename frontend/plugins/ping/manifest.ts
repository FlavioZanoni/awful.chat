import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "ping",
  name: "Ping",
  description:
    "Measure the round trip to up to three people and graph it while it runs.",
  icon: "lucide:activity",
  author: "awful.chat",
  license: "Apache-2.0",
  version: "1.0.0",
  repository:
    "https://github.com/awful-org/awful.chat/tree/main/frontend/plugins/ping",
  apiVersion: 1,
  commands: [{ name: "ping", usage: "/ping @alice, @bob, @carol" }],
};
