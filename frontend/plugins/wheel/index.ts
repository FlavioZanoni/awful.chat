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
      // Poll-style optional question: "/wheel What game? CS, Dota, REPO".
      // Everything before the first "?" is the question; without one the
      // whole input is the option list, exactly as before.
      const qIndex = args.indexOf("?");
      const question = qIndex >= 0 ? args.slice(0, qIndex + 1).trim() : "";
      const optionText = qIndex >= 0 ? args.slice(qIndex + 1) : args;
      const options = optionText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (options.length < 2) {
        console.warn(
          "[wheel] format: /wheel Question? option1, option2 (question optional)"
        );
        return;
      }
      await host.sendCard({ question, options });
    },
  },
});
