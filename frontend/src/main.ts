import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { registerSW } from "virtual:pwa-register";

registerSW({
  immediate: true,
  onNeedRefresh() {
    // registerType is "prompt", so nothing happens unless we say something -
    // and there was no handler here at all, which left people running the
    // previous build with no way to know. sw.ts already calls skipWaiting, so
    // the new build is live in the cache and a plain reload picks it up; we do
    // not force one, because that would drop a call or a half-typed message.
    // Imported lazily so the entry point does not pull the transport in ahead
    // of App.
    import("$lib/transport/transport.svelte")
      .then(({ _transport }) =>
        _transport.announce({
          type: "app-warning",
          message: "A new version is ready - reload when convenient.",
        })
      )
      .catch(() => {});
  },
});

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
