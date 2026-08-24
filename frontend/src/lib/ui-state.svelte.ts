/**
 * Tiny cross-component UI requests. The settings dialog is owned by
 * SidebarControls; anything else that wants to open it (a profile card's
 * edit button, deep in the chat) writes here and the owner reacts.
 */
export const uiState = $state({
  settingsOpenRequested: false,
  settingsTab: null as string | null,
});

export function openSettings(tab: string | null = null): void {
  uiState.settingsTab = tab;
  uiState.settingsOpenRequested = true;
}
