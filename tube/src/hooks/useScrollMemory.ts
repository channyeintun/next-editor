import { useLayoutEffect, useState } from "react";
import { useLocation } from "react-router";

/**
 * Scroll restoration for the gallery: Back (or Forward) to a history entry
 * puts its view where it was left.
 *
 * The browser's own restoration cannot: it runs at the history traversal,
 * while the page being left is still on screen, and the gallery's cards mount
 * only once the router has rendered the route.
 *
 * Kept in memory, like the query cache that holds the cards. A reload drops
 * both, and the page starts at the top with its first page of cards.
 */

/** A view as it was left. */
interface ScrollSnapshot<Layout> {
  /** The page's scroll offset. */
  offset: number;
  /** The viewport width the view was laid out for. */
  viewportWidth: number;
  /** What the view kept of its own layout, for a view that measures one. */
  layout: Layout;
}

// By view and history entry, oldest first. A long session visits many
// entries; past this many, the one left longest ago starts at the top again.
const MAX_SNAPSHOTS = 50;
const snapshots = new Map<string, ScrollSnapshot<unknown>>();

function recall<Layout>(id: string): ScrollSnapshot<Layout> | undefined {
  const snapshot = snapshots.get(id) as ScrollSnapshot<Layout> | undefined;
  // At another width the cards have other sizes and the rows hold other
  // cards, so the same offset would show another part of the list.
  return snapshot?.viewportWidth === window.innerWidth ? snapshot : undefined;
}

function remember(id: string, snapshot: ScrollSnapshot<unknown>): void {
  // Deleted first, so that a view left again counts as the newest.
  snapshots.delete(id);
  snapshots.set(id, snapshot);
  if (snapshots.size > MAX_SNAPSHOTS) {
    for (const oldest of snapshots.keys()) {
      snapshots.delete(oldest);
      break;
    }
  }
}

export interface ScrollMemory<Layout> {
  /**
   * How this view was left when its history entry was last on screen. The page
   * is scrolled back to the offset when the view mounts; a view that lays
   * itself out from the offset (a virtualized list) reads it here.
   */
  restored: { offset: number; layout: Layout } | undefined;
  /** Records how the view is being left, with the layout it wants back. */
  remember: (layout: Layout) => void;
}

interface OpenScrollMemory<Layout> extends ScrollMemory<Layout> {
  /** Scrolls the page back to where the view was left. */
  restore: () => void;
  /** Follows the page's offset; returns how to stop. */
  follow: () => () => void;
}

function openScrollMemory<Layout>(id: string): OpenScrollMemory<Layout> {
  const restored = recall<Layout>(id);
  // Where the reader has the page. Followed from scroll events, not read when
  // the view is left: by then the page may no longer be the reader's.
  let offset = 0;
  // Back or Forward has started. The browser restores the scroll position of
  // the entry it is going to at once, on the page still on screen, so until
  // the router gets there the page's offset is that entry's, not this view's.
  let traversing = false;
  const onScroll = () => {
    if (!traversing) offset = window.scrollY;
  };
  const onTraversal = () => {
    traversing = true;
  };

  return {
    restored,
    remember: (layout) => remember(id, { offset, viewportWidth: window.innerWidth, layout }),
    restore: () => {
      if (restored) window.scrollTo(0, restored.offset);
    },
    follow: () => {
      traversing = false;
      offset = window.scrollY;
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("popstate", onTraversal);
      return () => {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("popstate", onTraversal);
      };
    },
  };
}

/**
 * The memory of one view in the history entry it mounts in. `view` names the
 * view: an entry can show more than one over its life (a search's entry shows
 * the gallery, dimmed, until the search answers), each with its own offset.
 *
 * For a view that keeps a layout of its own, which it hands to `remember` in
 * a layout effect's cleanup. Any other view: useWindowScrollMemory.
 */
export function useScrollMemory<Layout = undefined>(view: string): ScrollMemory<Layout> {
  const location = useLocation();
  // The entry the view mounted in, for the view's whole life. A view can
  // outlive its entry (the gallery under a search's URL, above), and what it
  // leaves is then still how that first entry looked.
  const [memory] = useState(() => openScrollMemory<Layout>(`${view}:${location.key}`));
  useLayoutEffect(() => memory.restore(), [memory]);
  // Again at every navigation the view stays mounted through: a traversal has
  // then landed, and the page's offset is the reader's once more.
  useLayoutEffect(() => memory.follow(), [memory, location]);
  return memory;
}

/**
 * Scroll restoration for a view that is whole when it mounts and measures
 * nothing: the page goes back to the offset the view was left at.
 */
export function useWindowScrollMemory(view: string): void {
  const { remember } = useScrollMemory(view);
  useLayoutEffect(() => () => remember(undefined), [remember]);
}
