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

// A tab that loaded before a deploy holds the old index.html, and its lazy
// imports (webtorrent, mediasoup-client, shiki...) point at hashed chunks the
// new deploy deleted - the click that needed one just failed. Vite fires this
// event for exactly that; a reload gets the new index whose chunks all exist.
// The once-a-minute guard stops a reload loop when the failure is not a stale
// hash (offline, server down).
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem("preload-error-reload") ?? 0);
  if (Date.now() - last < 60_000) return; // let it surface as a normal error
  sessionStorage.setItem("preload-error-reload", String(Date.now()));
  event.preventDefault();
  window.location.reload();
});

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
