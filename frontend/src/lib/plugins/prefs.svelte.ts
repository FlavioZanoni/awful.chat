/**
 * Plugin preferences for the current device.
 * Stores disabled plugin IDs in localStorage, following display-prefs pattern.
 */

const DISABLED_PLUGINS_KEY = "awful:plugin-disabled:v1";
const PINNED_WIDGETS_KEY = "awful:plugin-widgets:v1";
export const MAX_PINNED_WIDGETS = 3;

export interface PinnedWidget {
  pluginId: string;
  cardId: string;
  roomCode: string;
}

function readPinnedWidgets(): PinnedWidget[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_WIDGETS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PinnedWidget =>
        !!p &&
        typeof p.pluginId === "string" &&
        typeof p.cardId === "string" &&
        typeof p.roomCode === "string"
    );
  } catch {
    return [];
  }
}

function readDisabledPlugins(): string[] {
  if (typeof localStorage === "undefined") return [];
  const stored = localStorage.getItem(DISABLED_PLUGINS_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const pluginPrefs = $state({
  disabledPluginIds: readDisabledPlugins(),
  pinnedWidgets: readPinnedWidgets(),
});

function persistPinned(): void {
  try {
    localStorage.setItem(
      PINNED_WIDGETS_KEY,
      JSON.stringify(pluginPrefs.pinnedWidgets)
    );
  } catch {
    // Storage blocked: the pin does not survive a reload
  }
}

export function isWidgetPinned(cardId: string): boolean {
  return pluginPrefs.pinnedWidgets.some((p) => p.cardId === cardId);
}

/** Pin a card to a sidebar box. At capacity the OLDEST pin makes room.
 *  replacePlugin: singleton plugins swap out their previous pin instead of
 *  occupying a second slot. */
export function pinWidget(
  pin: PinnedWidget,
  opts?: { replacePlugin?: boolean }
): void {
  const rest = pluginPrefs.pinnedWidgets.filter(
    (p) =>
      p.cardId !== pin.cardId &&
      (!opts?.replacePlugin || p.pluginId !== pin.pluginId)
  );
  pluginPrefs.pinnedWidgets = [...rest, pin].slice(-MAX_PINNED_WIDGETS);
  persistPinned();
}

export function unpinWidget(cardId: string): void {
  pluginPrefs.pinnedWidgets = pluginPrefs.pinnedWidgets.filter(
    (p) => p.cardId !== cardId
  );
  persistPinned();
}

export function togglePlugin(pluginId: string, enabled: boolean): void {
  if (enabled) {
    pluginPrefs.disabledPluginIds = pluginPrefs.disabledPluginIds.filter(
      (id) => id !== pluginId
    );
  } else {
    if (!pluginPrefs.disabledPluginIds.includes(pluginId)) {
      pluginPrefs.disabledPluginIds = [
        ...pluginPrefs.disabledPluginIds,
        pluginId,
      ];
    }
  }

  try {
    localStorage.setItem(
      DISABLED_PLUGINS_KEY,
      JSON.stringify(pluginPrefs.disabledPluginIds)
    );
  } catch {
    // Storage blocked: the choice does not survive a reload
  }
}

export function isPluginEnabled(pluginId: string): boolean {
  return !pluginPrefs.disabledPluginIds.includes(pluginId);
}

// Sync with other tabs
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === DISABLED_PLUGINS_KEY) {
      try {
        const parsed = e.newValue ? JSON.parse(e.newValue) : [];
        if (Array.isArray(parsed)) {
          pluginPrefs.disabledPluginIds = parsed;
        }
      } catch {
        // Ignore parse errors
      }
    }
    if (e.key === PINNED_WIDGETS_KEY) {
      pluginPrefs.pinnedWidgets = readPinnedWidgets();
    }
  });
}
