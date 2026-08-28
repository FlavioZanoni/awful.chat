<script lang="ts">
  /**
   * Interactive crop editor. The image sits behind a fixed crop frame; the
   * user pans it by dragging and zooms with the slider or the wheel. Apply
   * emits a normalized crop rectangle - the heavy pixel work happens in the
   * caller through `cropImageToDataUrl`.
   *
   * An animated GIF keeps playing while it is framed, so the user sees exactly
   * what they crop.
   */
  import { RotateCcw } from "@lucide/svelte";
  import Button from "$lib/components/ui/button/button.svelte";
  import type { CropRect } from "$lib/crop";
  import { coverBaseScale, clampOffset, rectFromView } from "$lib/crop-geometry";

  interface Props {
    src: string;
    /** Output aspect ratio, width / height. */
    aspect: number;
    /** Show the frame as a circle (avatar) instead of a rectangle (banner). */
    circle?: boolean;
    onCancel: () => void;
    onApply: (rect: CropRect) => void;
    /** True while the caller re-encodes the crop. */
    busy?: boolean;
  }

  let { src, aspect, circle = false, onCancel, onApply, busy = false }: Props =
    $props();

  // Frame footprint on screen, fitted into the dialog content area.
  const MAX_W = 288;
  const MAX_H = 232;
  const frameW = $derived(
    Math.round(Math.min(MAX_W, MAX_H * aspect))
  );
  const frameH = $derived(Math.round(frameW / aspect));

  const MAX_ZOOM = 4;
  let natW = $state(0);
  let natH = $state(0);
  let baseScale = $state(1);
  let zoom = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let loadError = $state(false);

  const scale = $derived(baseScale * zoom);
  const ready = $derived(natW > 0 && natH > 0);

  function recenter() {
    const dispW = natW * scale;
    const dispH = natH * scale;
    offsetX = clampOffset((frameW - dispW) / 2, dispW, frameW);
    offsetY = clampOffset((frameH - dispH) / 2, dispH, frameH);
  }

  function reset() {
    if (!ready) return;
    baseScale = coverBaseScale(natW, natH, frameW, frameH);
    zoom = 1;
    recenter();
  }

  function onImgLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    natW = img.naturalWidth;
    natH = img.naturalHeight;
    loadError = natW === 0 || natH === 0;
    if (!loadError) reset();
  }

  // Keep the frame centre fixed while zooming so the image does not jump.
  function applyZoom(nextZoom: number) {
    const clamped = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    const oldScale = scale;
    const newScale = baseScale * clamped;
    const focalX = (frameW / 2 - offsetX) / oldScale;
    const focalY = (frameH / 2 - offsetY) / oldScale;
    zoom = clamped;
    const dispW = natW * newScale;
    const dispH = natH * newScale;
    offsetX = clampOffset(frameW / 2 - focalX * newScale, dispW, frameW);
    offsetY = clampOffset(frameH / 2 - focalY * newScale, dispH, frameH);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e: PointerEvent) {
    if (!ready) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dispW = natW * scale;
    const dispH = natH * scale;
    offsetX = clampOffset(offsetX + (e.clientX - lastX), dispW, frameW);
    offsetY = clampOffset(offsetY + (e.clientY - lastY), dispH, frameH);
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function onPointerUp(e: PointerEvent) {
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function apply() {
    if (!ready) return;
    onApply(
      rectFromView({ natW, natH, frameW, frameH, scale, offsetX, offsetY })
    );
  }
</script>

<div class="flex h-full flex-col items-center gap-3 p-4">
  {#if loadError}
    <div
      class="flex flex-1 items-center justify-center text-sm text-destructive font-mono"
    >
      This image could not be loaded for cropping.
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center">
      <div
        role="application"
        aria-label="Drag to reposition"
        class="relative touch-none overflow-hidden bg-muted select-none {circle
          ? 'rounded-full'
          : 'rounded-lg'} ring-2 ring-primary/60 {ready
          ? 'cursor-grab active:cursor-grabbing'
          : ''}"
        style="width:{frameW}px;height:{frameH}px;"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onwheel={onWheel}
      >
        <img
          {src}
          alt="Crop preview"
          draggable="false"
          onload={onImgLoad}
          onerror={() => (loadError = true)}
          class="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left"
          style="width:{natW}px;height:{natH}px;transform:translate({offsetX}px,{offsetY}px) scale({scale});"
        />
      </div>
    </div>

    <div class="flex w-full items-center gap-3 px-1">
      <span class="text-xs font-mono text-muted-foreground select-none">Zoom</span>
      <input
        type="range"
        min="1"
        max={MAX_ZOOM}
        step="0.01"
        value={zoom}
        oninput={(e) => applyZoom(Number((e.target as HTMLInputElement).value))}
        disabled={!ready}
        aria-label="Zoom"
        class="h-1.5 flex-1 cursor-pointer accent-primary"
      />
      <button
        type="button"
        onclick={reset}
        disabled={!ready}
        aria-label="Reset crop"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40"
      >
        <RotateCcw class="size-4" />
      </button>
    </div>
  {/if}

  <div class="flex w-full items-center justify-end gap-2">
    <Button variant="ghost" size="sm" onclick={onCancel} disabled={busy}>
      Cancel
    </Button>
    <Button size="sm" onclick={apply} disabled={!ready || busy}>
      {busy ? "Cropping..." : "Apply crop"}
    </Button>
  </div>
</div>
