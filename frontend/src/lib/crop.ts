/**
 * Crop an image or an animated GIF to a fixed output size.
 *
 * A static image is drawn once onto a canvas and exported as WebP. An animated
 * GIF is decoded frame by frame, each full frame is composited (GIF frames are
 * patches with disposal rules), cropped, and the sequence is re-encoded as a
 * new GIF so the animation survives the crop.
 *
 * The crop rectangle is normalized to the natural image size, so the caller
 * (the cropper UI) never needs the real pixel dimensions.
 */
import { parseGIF, decompressFrames, type ParsedFrame } from "gifuct-js";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

/** A crop region in [0,1] coordinates, relative to the natural image size. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropTarget {
  /** Output width in pixels. */
  outWidth: number;
  /** Output height in pixels. */
  outHeight: number;
  /**
   * Byte budget for the encoded result. A GIF that exceeds it is re-encoded at
   * a smaller size. A static WebP is small enough that it never trips this.
   */
  maxBytes: number;
}

/** The full crop region - the identity crop that selects the whole image. */
export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

function isGifBytes(b: Uint8Array): boolean {
  // "GIF87a" or "GIF89a"
  return (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  );
}

async function fetchBytes(
  src: string
): Promise<{ bytes: Uint8Array; type: string }> {
  // A remote host without CORS headers rejects here; the caller turns the
  // rejection into a message that points the user at the upload tab.
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Could not load the image (HTTP ${res.status}).`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), type };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + chunk) as unknown as number[])
    );
  }
  return btoa(binary);
}

function get2d(
  canvas: HTMLCanvasElement,
  willReadFrequently = false
): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently });
  if (!ctx) throw new Error("Canvas 2D context is unavailable.");
  return ctx;
}

async function cropStatic(
  bytes: Uint8Array,
  type: string,
  rect: CropRect,
  target: CropTarget
): Promise<string> {
  // Decode through a same-origin blob URL. Drawing a cross-origin <img>
  // straight from its remote URL would taint the canvas and block the export.
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: type || "image/png",
  });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = target.outWidth;
    canvas.height = target.outHeight;
    const ctx = get2d(canvas);
    ctx.drawImage(
      img,
      rect.x * img.naturalWidth,
      rect.y * img.naturalHeight,
      rect.w * img.naturalWidth,
      rect.h * img.naturalHeight,
      0,
      0,
      target.outWidth,
      target.outHeight
    );

    const webp = canvas.toDataURL("image/webp", 0.92);
    // A browser without WebP encode returns a PNG data URL from the WebP call.
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeGif(
  frames: ParsedFrame[],
  fullW: number,
  fullH: number,
  rect: CropRect,
  outW: number,
  outH: number
): Uint8Array {
  const full = document.createElement("canvas");
  full.width = fullW;
  full.height = fullH;
  const fctx = get2d(full, true);

  const patchCanvas = document.createElement("canvas");
  const pctx = get2d(patchCanvas);

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = get2d(out, true);

  const sx = rect.x * fullW;
  const sy = rect.y * fullH;
  const sw = rect.w * fullW;
  const sh = rect.h * fullH;

  const enc = GIFEncoder();
  let prev: ParsedFrame | null = null;
  let restore: ImageData | null = null;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const { dims, patch, disposalType, delay } = frame;

    // Apply the previous frame's disposal before drawing this one.
    if (prev) {
      if (prev.disposalType === 2) {
        fctx.clearRect(
          prev.dims.left,
          prev.dims.top,
          prev.dims.width,
          prev.dims.height
        );
      } else if (prev.disposalType === 3 && restore) {
        fctx.putImageData(restore, 0, 0);
      }
    }
    // Disposal 3 means "revert to the state before this frame", so snapshot now.
    if (disposalType === 3) restore = fctx.getImageData(0, 0, fullW, fullH);

    patchCanvas.width = dims.width;
    patchCanvas.height = dims.height;
    pctx.putImageData(
      new ImageData(new Uint8ClampedArray(patch), dims.width, dims.height),
      0,
      0
    );
    fctx.drawImage(patchCanvas, dims.left, dims.top);

    // Every output frame is a complete cropped image, so encode it whole and
    // restore to a transparent background between frames.
    octx.clearRect(0, 0, outW, outH);
    octx.drawImage(full, sx, sy, sw, sh, 0, 0, outW, outH);
    const rgba = octx.getImageData(0, 0, outW, outH).data;

    const palette = quantize(rgba, 256, { format: "rgba4444" });
    const index = applyPalette(rgba, palette, "rgba4444");
    enc.writeFrame(index, outW, outH, {
      palette,
      transparent: true,
      dispose: 2,
      delay: delay || 100,
      ...(i === 0 ? { first: true, repeat: 0 } : {}),
    });

    prev = frame;
  }

  enc.finish();
  return enc.bytes();
}

async function cropGif(
  bytes: Uint8Array,
  rect: CropRect,
  target: CropTarget
): Promise<string> {
  const parsed = parseGIF(bytes.buffer as ArrayBuffer);
  const frames = decompressFrames(parsed, true);
  if (frames.length === 0) throw new Error("The GIF has no frames.");

  const fullW = parsed.lsd.width;
  const fullH = parsed.lsd.height;

  // Re-encoding can grow a GIF. If the result blows the byte budget, shrink the
  // output and try again, keeping the smallest attempt as the floor.
  const scales = [1, 0.8, 0.6, 0.45];
  let encoded: Uint8Array | null = null;
  for (const scale of scales) {
    const outW = Math.max(2, Math.round(target.outWidth * scale));
    const outH = Math.max(2, Math.round(target.outHeight * scale));
    encoded = encodeGif(frames, fullW, fullH, rect, outW, outH);
    if (encoded.length <= target.maxBytes) break;
  }
  return "data:image/gif;base64," + toBase64(encoded!);
}

/**
 * Crop `src` (a data URL, blob URL, or CORS-reachable URL) to `target` and
 * return a data URL. An animated GIF stays animated; anything else becomes a
 * static WebP. Rejects when the source cannot be fetched or decoded.
 */
export async function cropImageToDataUrl(
  src: string,
  rect: CropRect,
  target: CropTarget
): Promise<string> {
  const { bytes, type } = await fetchBytes(src);
  if (isGifBytes(bytes)) return cropGif(bytes, rect, target);
  return cropStatic(bytes, type, rect, target);
}
