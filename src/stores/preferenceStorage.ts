/**
 * localStorage access for user preferences, which must never break the app.
 * Reading `window.localStorage` throws where the browser denies the document
 * storage (site data blocked, or third-party storage blocked for an embedded
 * lesson), and `setItem` throws when the origin is full. A preference that
 * cannot be read falls back to its default; one that cannot be written is simply
 * not remembered.
 */
export function readStoredPreference(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value` under `key`, or remove the key when `value` is null. */
export function writeStoredPreference(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Unavailable or full: see above.
  }
}
