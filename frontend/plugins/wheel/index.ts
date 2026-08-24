import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import WheelCard from "./WheelCard.svelte";
import { initialState, reduce } from "./logic";

export default definePlugin({
  manifest,
  card: WheelCard,
  initialState,
  reduce,
  commands: {
    wheel: async (args: string, host: HostApi) => {
      const options = args
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (options.length < 2) {
        console.warn("[wheel] need at least 2 options");
        return;
      }
      await host.sendCard({ options });
    },
  },
});
