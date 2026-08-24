/**
 * Plugin preferences for the current device.
 * Stores disabled plugin IDs in localStorage, following display-prefs pattern.
 */

const DISABLED_PLUGINS_KEY = "awful:plugin-disabled:v1";

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
});

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
  });
}
