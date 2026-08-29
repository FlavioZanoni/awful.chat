/**
 * Re-encode an image in the browser, for the lightbox's download menu.
 *
 * Everything here goes through a canvas, which has two consequences worth
 * knowing before using it: an animated GIF comes back as a single still
 * frame, because a canvas holds one frame and nothing else; and the encode
 * is limited to what the browser itself can write. AVIF is deliberately
 * absent for that second reason - browsers decode it and do not encode it,
 * so offering it would need a WASM encoder shipped for one menu item, while
 * WebP covers the same ground natively.
 */

export interface ConvertTarget {
  mime: string;
  label: string;
  ext: string;
}

const TARGETS: ConvertTarget[] = [
  { mime: "image/png", label: "PNG", ext: "png" },
  { mime: "image/jpeg", label: "JPEG", ext: "jpg" },
  { mime: "image/webp", label: "WebP", ext: "webp" },
];

/**
 * The formats worth offering for a source image: all of them except the one
 * it already is, since "convert" to the current format is what the Original
 * entry already does, losslessly and for free.
 */
export function convertTargets(sourceMime: string): ConvertTarget[] {
  if (!sourceMime || !sourceMime.startsWith("image/")) return [];
  // image/jpg is not a real mime type but people and some tools emit it.
  const src = sourceMime === "image/jpg" ? "image/jpeg" : sourceMime;
  return TARGETS.filter((t) => t.mime !== src);
}

/** Swap a filename's extension, keeping any dots inside the name itself. */
export function withExtension(filename: string, ext: string): string {
  const base = filename.replace(/\.[^./\\]*$/, "");
  return `${base || "image"}.${ext}`;
}

export async function convertImage(
  blob: Blob,
  target: string
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("This browser will not give us a canvas to convert with.");
  }
  // JPEG has no alpha channel. Without a ground to composite onto, every
  // transparent pixel encodes as black, which is a startling thing to hand
  // someone who just wanted a smaller file.
  if (target === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, target, 0.92)
  );
  if (!out) throw new Error(`This browser cannot write ${target}.`);
  // toBlob falls back to PNG for a type it cannot encode, silently. Handing
  // that back would save a PNG under a .jpg name, so check what we actually
  // got rather than what we asked for.
  if (out.type !== target) {
    throw new Error(`This browser cannot write ${target}.`);
  }
  return out;
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers; one turn
  // of the event loop is enough for the click to have been taken.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
