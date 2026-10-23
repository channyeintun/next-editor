import type { EditorActionArgs, EditorContextUpdate, EditorMachineContext } from "./types";
import type { Recording } from "../types";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../runtime";
import type { SlideEvent } from "../slides";
import type { WhiteboardEvent, WhiteboardSceneState } from "../whiteboard";
import { findTimedEventIndexAtOrBefore } from "../utils/timedIndex";
import {
  getRuntimeDockViewChangeIndex,
  getSlideViewChangeIndex,
  getWhiteboardViewChangeIndex,
  withRuntimeDockView,
  withSlideView,
  withWhiteboardView,
  type SlideReplayApplication,
} from "./replayState";

// ============================================================================
// The viewer's own view of the replayed panels
//
// While a lesson is loaded for playback (ready, playing, paused or ended), the viewer may
// open, close, maximize or restore the whiteboard and the slides, and collapse or expand the
// runtime dock. The app shows their choice at once in its own store and sends
// VIEWER_PANEL_VIEW_CHANGED; this module keeps the replay from undoing it.
//
// The rule: the viewer's view of a panel holds until the recording itself next changes how
// that panel is shown (opens, closes, maximizes, restores, collapses or expands it). Then
// the recording takes over again, so the lesson still shows what the author showed when it
// mattered. Drawing, slide navigation and terminal output change what is in a panel, not
// whether it is shown, so they do not end it.
//
// A hold is the track's latest recorded view change at the playhead when the viewer chose
// (-1 before any). A replay step that applies a panel's state checks the hold against the
// latest view change at the index it reached. The same one means the recording has not
// changed the view since, so the step applies the recorded state shown the viewer's way,
// read back from the app's getter, which holds what is on screen. Another one (playback
// crossed a change, or a seek or a restart left that stretch) drops the hold for good, and
// the recorded state applies as it is. Playing on, seeking, pausing and resuming, and
// restarting (a seek to 0) therefore all follow the one rule. A seek back into the stretch
// does not bring a dropped hold back. Holds end with the recording: loading another one, or
// unloading it, clears them. The dock's full-height toggle is not a panel view here; it keeps
// its own session-long choice in the app's runtime panel store.
// ============================================================================

export type ViewerPanel = "whiteboard" | "slides" | "runtimeDock";

/** Per panel the viewer has shown their own way: the recorded view change their view follows. */
export type ViewerPanelHolds = Partial<Record<ViewerPanel, number>>;

/** The viewer changed how `panel` is shown; the app already shows it. Playback only. */
export type ViewerPanelViewChangedEvent = {
  type: "VIEWER_PANEL_VIEW_CHANGED";
  panel: ViewerPanel;
};

/** A loaded or unloaded recording starts with every panel following it. */
export const VIEWER_PANEL_HOLDS_RESET = {
  viewerPanelHolds: {},
} as const satisfies EditorContextUpdate;

/** The latest recorded change to how `panel` is shown at `time`, or -1. */
function getViewChangeIndexAt(recording: Recording, panel: ViewerPanel, time: number): number {
  switch (panel) {
    case "whiteboard": {
      const events = recording.whiteboardEvents ?? [];
      return getWhiteboardViewChangeIndex(events, findTimedEventIndexAtOrBefore(events, time, -1));
    }
    case "slides": {
      const events = recording.slideEvents ?? [];
      return getSlideViewChangeIndex(events, findTimedEventIndexAtOrBefore(events, time, -1));
    }
    case "runtimeDock": {
      const events = recording.runtimeEvents ?? [];
      return getRuntimeDockViewChangeIndex(events, findTimedEventIndexAtOrBefore(events, time, -1));
    }
  }
}

/** VIEWER_PANEL_VIEW_CHANGED: hold the panel the viewer's way from the playhead on. */
export const holdViewerPanelView = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "VIEWER_PANEL_VIEW_CHANGED" || !context.recording) return {};
  return {
    viewerPanelHolds: {
      ...context.viewerPanelHolds,
      [event.panel]: getViewChangeIndexAt(
        context.recording,
        event.panel,
        context.timeline.currentTime,
      ),
    },
  };
};

interface ViewerPanelHold {
  isHeld: boolean;
  /** The holds to store when this one lapsed; empty otherwise. */
  update: EditorContextUpdate;
}

const NOT_HELD: ViewerPanelHold = { isHeld: false, update: {} };
const HELD: ViewerPanelHold = { isHeld: true, update: {} };

/**
 * Whether the viewer's view of `panel` still holds where a replay step brought its track,
 * given the latest recorded view change there (read only when there is a hold).
 */
function resolveViewerPanelHold(
  context: EditorMachineContext,
  panel: ViewerPanel,
  getViewChangeIndex: () => number,
): ViewerPanelHold {
  const hold = context.viewerPanelHolds[panel];
  if (hold === undefined) return NOT_HELD;
  if (hold === getViewChangeIndex()) return HELD;
  const { [panel]: _lapsed, ...stillHeld } = context.viewerPanelHolds;
  return { isHeld: false, update: { viewerPanelHolds: stillHeld } };
}

/** The whiteboard scene a replay step applies at `index`: as recorded, or the viewer's way. */
export function showWhiteboardForViewer(
  context: EditorMachineContext,
  events: WhiteboardEvent[],
  index: number,
  scene: WhiteboardSceneState,
): { scene: WhiteboardSceneState; update: EditorContextUpdate } {
  const hold = resolveViewerPanelHold(context, "whiteboard", () =>
    getWhiteboardViewChangeIndex(events, index),
  );
  const shown = hold.isHeld ? context.getWhiteboardState?.() : null;
  return { scene: shown ? withWhiteboardView(scene, shown) : scene, update: hold.update };
}

/** The deck states a replay step applies up to `index`: as recorded, or the viewer's way. */
export function showSlidesForViewer(
  context: EditorMachineContext,
  events: SlideEvent[],
  index: number,
  applications: SlideReplayApplication[],
): { applications: SlideReplayApplication[]; update: EditorContextUpdate } {
  if (applications.length === 0) return { applications, update: {} };
  const hold = resolveViewerPanelHold(context, "slides", () =>
    getSlideViewChangeIndex(events, index),
  );
  const shown = hold.isHeld ? context.getSlideState?.()?.previewState : null;
  if (!shown) return { applications, update: hold.update };
  const view = { isOpen: shown.isOpen, isMaximized: shown.isMaximized ?? false };
  return {
    applications: applications.map((application) => ({
      ...application,
      slideState: withSlideView(application.slideState, view),
    })),
    update: hold.update,
  };
}

/** The runtime state a replay step applies at `index`: as recorded, or the viewer's way. */
export function showRuntimeDockForViewer(
  context: EditorMachineContext,
  events: RuntimeRecordingEvent[],
  index: number,
  snapshot: RuntimeRecordingSnapshot,
): { snapshot: RuntimeRecordingSnapshot; update: EditorContextUpdate } {
  const hold = resolveViewerPanelHold(context, "runtimeDock", () =>
    getRuntimeDockViewChangeIndex(events, index),
  );
  const shown = hold.isHeld ? context.getRuntimeSnapshot?.() : null;
  return {
    snapshot: shown ? withRuntimeDockView(snapshot, shown.isCollapsed ?? false) : snapshot,
    update: hold.update,
  };
}
