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

/**
 * Keeps a store's preferences in storage, one key per serializer. On each
 * emission a key is written only when its serialized value differs from the
 * one last seen (null removes the key), so a slider dragged through many
 * values writes one key per step, and a change in one tab never overwrites
 * another tab's newer value for a key this tab did not change. A key whose
 * value never changes from the one the store started with is never written;
 * it reads back as that same value. Returns the unsubscribe.
 */
export function persistPreferences<TContext>(
  store: {
    getSnapshot(): { context: TContext };
    subscribe(listener: (snapshot: { context: TContext }) => void): { unsubscribe(): void };
  },
  serializers: Record<string, (context: TContext) => string | null>,
): () => void {
  const entries = Object.entries(serializers);
  const initial = store.getSnapshot().context;
  const last = new Map(entries.map(([key, serialize]) => [key, serialize(initial)]));

  const subscription = store.subscribe(({ context }) => {
    for (const [key, serialize] of entries) {
      const value = serialize(context);
      if (value === last.get(key)) continue;
      writeStoredPreference(key, value);
      last.set(key, value);
    }
  });
  return () => subscription.unsubscribe();
}
