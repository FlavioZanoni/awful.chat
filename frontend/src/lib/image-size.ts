/**
 * Intrinsic image dimensions, so a picture can occupy its space before it
 * has loaded.
 *
 * Without these an image is zero-height until it decodes and then snaps to
 * full size, shoving everything below it down - which is why the chat had to
 * be re-scrolled once the images finished, and why a loading skeleton could
 * not be drawn at the right size. They are measured once by the sender, who
 * already holds the file, and travel with the announce.
 */

/**
 * The largest sane pixel dimension we will believe.
 *
 * These numbers arrive from a peer inside a signed message, which proves who
 * sent them and nothing about whether they are honest. A width of 1e9 in an
 * aspect-ratio is a layout weapon, so anything outside this range is treated
 * as "no dimensions" and the image falls back to loading the old way.
 */
const MAX_DIMENSION = 20000;

/** Tailwind's max-w-xs and max-h-56 on the inline image, in rem. */
const MAX_W_REM = 20;
const MAX_H_REM = 14;

/** Beyond this the box is a sliver, which is a layout weapon of its own. */
const MAX_RATIO = 20;

export function isSaneDimension(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_DIMENSION;
}

/**
 * The exact box an image of this shape will occupy, as an inline style.
 *
 * Both the skeleton and the image itself wear it, so the one is replaced by
 * the other with no reflow at all. CSS does the fitting: the width is
 * whichever of the two limits binds first, and aspect-ratio supplies the
 * height, so there is no measuring in JavaScript to drift out of step with
 * the class list.
 *
 * Returns "" when the dimensions are missing or untrustworthy, which leaves
 * the caller rendering exactly as it did before they existed.
 */
export function mediaBoxStyle(
  width: unknown,
  height: unknown
): string {
  if (!isSaneDimension(width) || !isSaneDimension(height)) return "";
  // A pair inside the range can still be absurd as a RATIO: 20000x1 passes
  // both bounds and lays out a box a fraction of a pixel tall.
  const ratio = width / height;
  if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) return "";
  const w = Math.min(
    MAX_W_REM,
    MAX_H_REM * ratio,
    // Never larger than the picture itself. The limits are a ceiling, not a
    // target: without this a 64x64 avatar got stretched to 224x224 and
    // blurred, where before it simply rendered at 64.
    width / 16
  );
  return `width: ${w.toFixed(3)}rem; aspect-ratio: ${width} / ${height};`;
}

/**
 * How long to wait for a file to tell us its size.
 *
 * This runs on the send path, before seeding, so a file that never reports
 * metadata would hold the send open indefinitely. Losing the dimensions
 * costs a layout shift; losing the send costs the message.
 */
const MEASURE_TIMEOUT_MS = 3000;

/**
 * Cleanups owed by measurements still in flight. A timeout abandons the
 * promise but not the resources it opened, so the timeout runs them itself.
 */
const releaseOnTimeout = new Set<() => void>();

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        for (const release of [...releaseOnTimeout]) {
          releaseOnTimeout.delete(release);
          try {
            release();
          } catch {
            // Best effort: a failed cleanup must not fail the send.
          }
        }
        resolve(null);
      }, MEASURE_TIMEOUT_MS);
    }),
  ]);
}

/**
 * Measure a local image or video. Resolves to null for anything else and for
 * anything that will not decode, so the caller can simply attach whatever
 * comes back.
 */
export async function measureMedia(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  // Both paths, not just video: the comment above promises the send path is
  // protected, and img.decode() on a hostile or truncated file is not
  // guaranteed to reject promptly either.
  if (file.type.startsWith("video/")) return withTimeout(measureVideo(file));
  if (!file.type.startsWith("image/")) return null;
  return withTimeout(measureImage(file));
}

async function measureImage(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      const { width, height } = bmp;
      bmp.close();
      if (isSaneDimension(width) && isSaneDimension(height)) {
        return { width, height };
      }
      return null;
    } catch {
      // Fall through: Safari has historically refused some formats here.
    }
  }
  if (typeof Image !== "function" || typeof URL === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    return isSaneDimension(width) && isSaneDimension(height)
      ? { width, height }
      : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A video reports its shape through metadata, which needs an element and a
 * load - there is no createImageBitmap equivalent. preload="metadata" keeps
 * it to the header rather than pulling the media down twice.
 */
async function measureVideo(
  file: Blob
): Promise<{ width: number; height: number } | null> {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return null;
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  // Released on the way out of the race too. A finally here only runs when
  // this promise settles, and when the timeout wins it never does - leaving
  // an element still fetching a URL that is never revoked.
  const release = () => {
    // Drop the source before revoking, or the element keeps fetching a URL
    // that no longer resolves.
    video.src = "";
    video.load();
    URL.revokeObjectURL(url);
  };
  releaseOnTimeout.add(release);
  try {
    video.preload = "metadata";
    // Muted and inline: some browsers refuse to load metadata for a video
    // they consider capable of making noise without a gesture.
    video.muted = true;
    video.playsInline = true;
    const ready = new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("metadata failed"));
    });
    video.src = url;
    await ready;
    const { videoWidth: width, videoHeight: height } = video;
    return isSaneDimension(width) && isSaneDimension(height)
      ? { width, height }
      : null;
  } catch {
    return null;
  } finally {
    releaseOnTimeout.delete(release);
    release();
  }
}
