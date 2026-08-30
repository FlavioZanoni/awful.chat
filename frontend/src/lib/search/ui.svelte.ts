/** Who is showing the search overlay, and over what. One owner, like the
 *  palette's open flag: the overlay reads it, hotkeys write it. */
export const searchUi = $state({
  open: false,
  /** Room to search, or null for everywhere. */
  scope: null as string | null,
});

export function openSearch(scope: string | null): void {
  searchUi.scope = scope;
  searchUi.open = true;
}

export function closeSearch(): void {
  searchUi.open = false;
}
