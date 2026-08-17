/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { precacheAndRoute, matchPrecache } from "workbox-precaching";
import { storeSharedPayload } from "$lib/share-target";

declare let self: ServiceWorkerGlobalScope;

clientsClaim();
self.skipWaiting();

precacheAndRoute(
  (self as ServiceWorkerGlobalScope & { __WB_MANIFEST: any }).__WB_MANIFEST
);

// Big, rarely-needed assets are kept OUT of the precache (see globIgnores in
// vite.config.ts) and cached the first time they are actually used instead:
//   - the DTLN wasm worklet (~8 MB), fetched once on first app start
//   - shiki language chunks (~300 files), fetched only when a code block of
//     that language is rendered
// Precaching them cost every visitor ~16 MB on install and on every update.
const WORKLET_CACHE = "dtln-worklet-v1";
const LANGS_CACHE = "shiki-langs-v1";

function runtimeCacheName(url: URL): string | null {
  if (url.origin !== self.location.origin) return null;
  if (url.pathname === "/audio-worklet.js") return WORKLET_CACHE;
  if (url.pathname.startsWith("/assets/langs/")) return LANGS_CACHE;
  return null;
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Hashed filenames, so a successful response is safe to keep forever.
  if (response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

/** The app is a SPA: every in-scope navigation is served by index.html. */
async function handleNavigation(request: Request): Promise<Response> {
  const cached = await matchPrecache("index.html");
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method === "POST") {
    const url = new URL(request.url);
    if (url.pathname !== "/share-target") return;

    event.respondWith(
      (async () => {
        try {
          const formData = await request.formData();
          const title = (formData.get("title") as string | null) ?? undefined;
          const text = (formData.get("text") as string | null) ?? undefined;
          const sharedUrl = (formData.get("url") as string | null) ?? undefined;
          const files = formData
            .getAll("files")
            .filter((value): value is File => value instanceof File);

          if (files.length > 0 || text || sharedUrl || title) {
            await storeSharedPayload({
              title,
              text,
              url: sharedUrl,
              files,
            });
          }
        } catch {
          // noop: we still redirect into app shell
        }

        return Response.redirect("/app?shared=1", 303);
      })()
    );
    return;
  }

  if (request.method !== "GET") return;

  // Without this the app simply does not open offline: precacheAndRoute only
  // matches exact URLs, so /app and /r/<code> miss the cache entirely even
  // though every message already lives on the device.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  const cacheName = runtimeCacheName(new URL(request.url));
  if (cacheName) {
    event.respondWith(cacheFirst(request, cacheName));
  }
});
