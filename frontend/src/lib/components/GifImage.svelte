<script lang="ts">
  /**
   * An image that can hold an animated GIF still. Browsers cannot pause a
   * GIF, so the trick is a canvas holding the first frame; the real img only
   * exists in the DOM while it is allowed to play, which also stops the
   * browser from spending decode work on it. A still image renders as a
   * plain img with zero overhead.
   *
   * animate: true = always play, false = always frozen, "hover" = play
   * while the pointer is over it.
   */
  interface Props {
    src: string;
    alt?: string;
    class?: string;
    animate?: boolean | "hover";
    /** Override URL sniffing when the caller already knows (e.g. mime type). */
    animated?: boolean;
    loading?: "lazy" | "eager";
  }

  let {
    src,
    alt = "",
    class: cls = "",
    animate = true,
    animated = undefined,
    loading,
  }: Props = $props();

  let hovered = $state(false);
  let canvasEl = $state<HTMLCanvasElement>();

  function urlLooksAnimated(s: string): boolean {
    if (s.startsWith("data:"))
      return (
        s.startsWith("data:image/gif") || s.startsWith("data:image/webp")
      );
    return /\.(gif|webp)([?#]|$)/i.test(s);
  }

  const isAnimated = $derived(animated ?? urlLooksAnimated(src));
  const playing = $derived(
    !isAnimated || animate === true || (animate === "hover" && hovered)
  );

  $effect(() => {
    if (playing || !canvasEl) return;
    const canvas = canvasEl;
    const img = new Image();
    img.src = src;
    let cancelled = false;
    img
      .decode()
      .then(() => {
        if (cancelled) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d")?.drawImage(img, 0, 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });
</script>

{#if playing}
  <img
    {src}
    {alt}
    class={cls}
    {loading}
    onmouseleave={animate === "hover" ? () => (hovered = false) : undefined}
  />
{:else}
  <canvas
    bind:this={canvasEl}
    class={cls}
    onmouseenter={animate === "hover" ? () => (hovered = true) : undefined}
    >{alt}</canvas
  >
{/if}
