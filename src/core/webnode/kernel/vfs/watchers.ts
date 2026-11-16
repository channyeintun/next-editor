// The filesystem's watch registry: who listens to which path, and delivering
// one change event to every matching listener. A watch follows its path string,
// so it keeps working when the watched entry is deleted and created again.
import type { VfsWatchEvent } from "./types";

interface Watcher {
  path: string;
  /** `path` plus a slash, the prefix of every entry below it. */
  prefix: string;
  recursive: boolean;
  listener: (event: VfsWatchEvent) => void;
  active: boolean;
}

/** The set of watches on one filesystem. */
export class WatchRegistry {
  private readonly watchers = new Set<Watcher>();

  /** True when at least one watch is registered, so callers can skip building event paths. */
  get active(): boolean {
    return this.watchers.size > 0;
  }

  /**
   * Watches the normalized absolute `path`: the entry itself and its direct
   * entries, or everything below it when `recursive`. Returns the function
   * that stops the watch; calling it again does nothing.
   */
  add(path: string, recursive: boolean, listener: (event: VfsWatchEvent) => void): () => void {
    const watcher: Watcher = {
      path,
      prefix: path === "/" ? "/" : `${path}/`,
      recursive,
      listener,
      active: true,
    };
    this.watchers.add(watcher);
    return () => {
      watcher.active = false;
      this.watchers.delete(watcher);
    };
  }

  /**
   * Delivers one event for the absolute `path` to every matching watch. A
   * listener that throws is skipped over: its error must not undo the change
   * that already happened or starve the other listeners, so it is dropped.
   */
  emit(eventType: VfsWatchEvent["eventType"], path: string): void {
    if (this.watchers.size === 0) {
      return;
    }
    const event: VfsWatchEvent = { eventType, path };
    // A Set skips entries deleted mid-iteration, so a listener may stop others.
    for (const watcher of this.watchers) {
      if (!watcher.active || !matches(watcher, path)) {
        continue;
      }
      try {
        watcher.listener(event);
      } catch {
        // See the doc comment: a listener's own failure stays with it.
      }
    }
  }
}

function matches(watcher: Watcher, path: string): boolean {
  if (path === watcher.path) {
    return true;
  }
  if (!path.startsWith(watcher.prefix)) {
    return false;
  }
  return watcher.recursive || path.indexOf("/", watcher.prefix.length) === -1;
}
