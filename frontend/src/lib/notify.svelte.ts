/**
 * notify.svelte.ts - app badge and local notifications.
 *
 * There is no push here and there cannot be: no server holds your messages, so
 * nothing exists to wake the app up when it is closed. What IS possible is
 * telling you about a message that arrived while the app is running but not on
 * screen (another tab, minimised, phone in your pocket with the PWA open), and
 * putting the unread count on the installed icon. Both are local-only.
 */

const PREF_KEY = "awful:notifications:v1";

export const notifyState = $state({
  /** User has switched notifications on in settings. */
  enabled: false,
  /** Browser-level permission, mirrored for the UI. */
  permission: "default" as NotificationPermission,
  supported: false,
});

if (typeof window !== "undefined") {
  notifyState.supported = "Notification" in window;
  if (notifyState.supported) notifyState.permission = Notification.permission;
  try {
    notifyState.enabled =
      localStorage.getItem(PREF_KEY) === "1" &&
      notifyState.permission === "granted";
  } catch {}
}

/**
 * Turn notifications on (asking the browser if needed) or off.
 * Must be called from a user gesture: browsers reject permission prompts
 * that are not tied to one.
 */
export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    notifyState.enabled = false;
    try {
      localStorage.setItem(PREF_KEY, "0");
    } catch {}
    return false;
  }
  if (!notifyState.supported) return false;

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return false;
    }
  }
  notifyState.permission = permission;
  notifyState.enabled = permission === "granted";
  try {
    localStorage.setItem(PREF_KEY, notifyState.enabled ? "1" : "0");
  } catch {}
  return notifyState.enabled;
}

/**
 * Notify about an incoming message.
 * Only fires when the app is actually out of sight - if you are looking at the
 * window, the message is already visible.
 */
export function notifyMessage(opts: {
  title: string;
  body: string;
  /** Collapses repeat notifications for the same conversation. */
  tag: string;
}): void {
  if (!notifyState.enabled || !notifyState.supported) return;
  if (Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;

  try {
    const notification = new Notification(opts.title, {
      body: opts.body.slice(0, 180),
      tag: opts.tag,
      icon: "/pwa-192x192.png",
      badge: "/pwa-64x64.png",
      silent: false,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {}
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker context;
    // failing to notify must never break message handling.
  }
}

/** Mirror the unread total onto the installed app icon. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) nav.setAppBadge?.(count)?.catch(() => {});
    else nav.clearAppBadge?.()?.catch(() => {});
  } catch {}
}
