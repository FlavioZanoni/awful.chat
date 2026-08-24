import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import PollCard from "./PollCard.svelte";
import { initialState, reduce } from "./logic";

export default definePlugin({
  manifest,
  card: PollCard,
  initialState,
  reduce,
  commands: {
    poll: async (args: string, host: HostApi) => {
      const parts = args.split("?");
      if (parts.length < 2) {
        console.warn("[poll] format: /poll Question? Option1, Option2, ...");
        return;
      }

      const question = parts[0].trim();
      const options = parts[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (options.length < 2) {
        console.warn("[poll] need at least 2 options");
        return;
      }

      await host.sendCard({ question, options });
    },
  },
});
