// ============================================================================
// Where a track last changed how its panel is shown.
//
// A viewer may open, close, maximize or collapse a replayed panel while a lesson
// plays, and their view holds until the recording changes that panel's view
// again (machine/viewerPanels.ts). Each track module says what its events do to
// the view; this keeps, per events array, the latest event at or before each
// index that changed it.
// ============================================================================

export interface ViewChangeTrack<Event, View> {
  /** The view before the track's first event. */
  initial: View;
  /** The view after `event`, given the view before it. */
  next: (view: View, event: Event) => View;
  isSameView: (left: View, right: View) => boolean;
}

interface ViewChangeIndex<View> {
  /** `latestChanges[i]`: the latest index at or before i whose event changed the view, or -1. */
  latestChanges: number[];
  /** The view after the last indexed event. */
  view: View;
}

/**
 * The index of the latest event at or before `index` that changed the view, or -1 when
 * none has since the track began. The fold is extended only as far as it is asked, and
 * kept per events array, which streamed playback only ever appends to in place.
 */
export function createViewChangeResolver<Event, View>(
  track: ViewChangeTrack<Event, View>,
): (events: Event[], index: number) => number {
  const indexByEvents = new WeakMap<Event[], ViewChangeIndex<View>>();

  return (events, index) => {
    const bounded = Math.min(index, events.length - 1);
    if (bounded < 0) {
      return -1;
    }

    let viewChanges = indexByEvents.get(events);
    if (!viewChanges) {
      viewChanges = { latestChanges: [], view: track.initial };
      indexByEvents.set(events, viewChanges);
    }

    const { latestChanges } = viewChanges;
    for (let cursor = latestChanges.length; cursor <= bounded; cursor += 1) {
      const view = track.next(viewChanges.view, events[cursor]);
      const changed = !track.isSameView(view, viewChanges.view);
      latestChanges.push(changed ? cursor : (latestChanges[cursor - 1] ?? -1));
      viewChanges.view = view;
    }

    return latestChanges[bounded];
  };
}
