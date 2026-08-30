/**
 * Plugin preferences for the current device.
 * Stores disabled plugin IDs in localStorage, following display-prefs pattern.
 */

const DISABLED_PLUGINS_KEY = "awful:plugin-disabled:v1";
const PINNED_WIDGETS_KEY = "awful:plugin-widgets:v2";
const LEGACY_PINNED_WIDGETS_KEY = "awful:plugin-widgets:v1";
export const MAX_PINNED_WIDGETS = 3;

/**
 * A pin names a PLUGIN, nothing more. v1 pinned a specific card, which froze
 * "pin waffle" to one particular party - ending it and joining the next left
 * the strip pointing at a corpse. The widget box resolves the plugin's
 * current subject at render time (widgetMine picks "my" card), and card-less
 * plugins (a soundboard) need no card at all.
 */
export interface PinnedWidget {
  pluginId: string;
}

function readPinnedWidgets(): PinnedWidget[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_WIDGETS_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      const pins = parsed.filter(
        (p): p is PinnedWidget => !!p && typeof p.pluginId === "string"
      );
      if (pins.length > 0) return pins;
    }
  } catch {
    // fall through to the legacy key
  }
  // v1 migration: card pins collapse to their plugin, deduplicated.
  try {
    const legacy = JSON.parse(
      localStorage.getItem(LEGACY_PINNED_WIDGETS_KEY) ?? "[]"
    );
    if (!Array.isArray(legacy)) return [];
    const seen = new Set<string>();
    const pins: PinnedWidget[] = [];
    for (const p of legacy) {
      const pluginId = (p as { pluginId?: unknown })?.pluginId;
      if (typeof pluginId !== "string" || seen.has(pluginId)) continue;
      seen.add(pluginId);
      pins.push({ pluginId });
    }
    return pins.slice(-MAX_PINNED_WIDGETS);
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

/** Pin a plugin to a sidebar box. At capacity the OLDEST pin makes room;
 *  one pin per plugin by construction. */
export function pinWidget(pluginId: string): void {
  const rest = pluginPrefs.pinnedWidgets.filter((p) => p.pluginId !== pluginId);
  pluginPrefs.pinnedWidgets = [...rest, { pluginId }].slice(
    -MAX_PINNED_WIDGETS
  );
  persistPinned();
}

export function unpinWidget(pluginId: string): void {
  pluginPrefs.pinnedWidgets = pluginPrefs.pinnedWidgets.filter(
    (p) => p.pluginId !== pluginId
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
