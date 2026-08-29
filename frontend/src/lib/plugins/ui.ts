/**
 * Components a plugin may render.
 *
 * This module IS the contract, the same way `api.ts` is for the host functions.
 * Plugins import from here and never from `$lib/components/...` directly:
 * a deep import would make every file under components/ public API by
 * accident, unversioned, so any tidy-up of that folder would silently break
 * third-party plugins that the host never sees.
 *
 * Adding an export here is a compatibility promise covered by the manifest's
 * apiVersion. Keep it to components that are genuinely self-contained - no
 * host state, no assumptions about where they are mounted - and prefer growing
 * the HostApi over growing this list, since data is a smaller promise to keep
 * than layout.
 */

/**
 * Tooltip for a single control.
 *
 *   <Tip text="Next track">
 *     {#snippet children(props)}
 *       <button {...props}>...</button>
 *     {/snippet}
 *   </Tip>
 *
 * Preferred over the native `title` attribute, which cannot be styled, has a
 * browser-controlled delay, and looks foreign next to the rest of the app.
 * The trigger props are handed to your own element rather than wrapping it, so
 * the tooltip attaches to the real control - no nested interactive elements -
 * and it opens on keyboard focus. It carries its own provider, so it works
 * wherever a plugin happens to be mounted.
 */
export { default as Tip } from "$lib/components/ui/tooltip/tip.svelte";
