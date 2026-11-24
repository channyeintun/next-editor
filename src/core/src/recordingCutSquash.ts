import type { ChatRecordingEvent } from "./chat";
import type { RuntimeRecordingEvent } from "./runtime";
import { resolveRuntimeSnapshotAt } from "./runtimeTrack";
import type { EditorFrame } from "./types";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "./utils/chatDelta";
import {
  applyWhiteboardEvent,
  deriveWhiteboardDelta,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "./whiteboard";
import { latestEditorModelBoundaryTime } from "./machine/frameReplay";
import {
  withFileContent,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "./workspace";

// ============================================================================
// Squashing what a track recorded inside a cut into its state at the cut's end.
//
// A cut collapses a span of the recording into one instant, so a viewer only
// ever sees what each track held when the span ended. Keeping every change made
// inside the span would keep, in the file, content that was added and removed
// there: a pasted key that was deleted again, a prompt that was never sent. So
// wherever a track can state a whole state in one event, the events of a cut are
// replaced by that one event:
//
//   * workspace: each event is a whole snapshot, so the last one stands for all
//     of them, with the width changes of the others added to it (and, when the
//     cut opens another file, the moment it did so: frames replay by it);
//   * runtime:   a `snapshot` event (the track's checkpoint) of the resolved state;
//   * chat:      a `checkpoint` event of the folded transcript and draft;
//   * whiteboard: the net delta between the scenes before and after the cut,
//     less the elements that were both created and deleted inside it.
//
// Each uses its track's own fold, so the state replay reaches after the cut is
// the state it reached before the edit. The preview's tracks are not here: rrweb
// segments and preview events are change logs with no event that states a whole
// state, so recordingEdit.ts keeps every one of theirs.
// ============================================================================

/** The cut a moment falls inside, as an index, or -1. */
type CutOf = (time: number) => number;

interface SquashOptions<T> {
  keepFirst?: boolean;
  /** Called with each event that is kept as it is, for a squash that folds the track. */
  passThrough?: (event: T) => void;
}

/**
 * Walks `events` (in time order) and hands each run that falls inside one cut to
 * `squashRun` as the indexes of its first and last event; events outside every cut
 * pass through. The result keeps the events' own timestamps: the caller retimes it.
 *
 * `keepFirst` passes the track's first event through as well. Loading a recording
 * applies the first workspace and runtime event whatever its time, so squashing it
 * into a cut would open the lesson on the state at that cut's end.
 */
function squashCutRuns<T extends { timestamp: number }>(
  events: readonly T[],
  cutOf: CutOf,
  squashRun: (first: number, last: number, cut: number) => readonly T[],
  { keepFirst = false, passThrough = () => {} }: SquashOptions<T> = {},
): T[] {
  const squashed: T[] = [];
  let index = 0;
  while (index < events.length) {
    const cut = keepFirst && index === 0 ? -1 : cutOf(events[index].timestamp);
    if (cut < 0) {
      passThrough(events[index]);
      squashed.push(events[index]);
      index += 1;
      continue;
    }
    let last = index;
    while (last + 1 < events.length && cutOf(events[last + 1].timestamp) === cut) last += 1;
    for (const event of squashRun(index, last, cut)) squashed.push(event);
    index = last + 1;
  }
  return squashed;
}

/** Whether any cut holds two or more of `events`: with none, there is nothing to squash. */
function hasRunToSquash(events: readonly { timestamp: number }[], cutOf: CutOf): boolean {
  return events.some((event, index) => {
    const cut = cutOf(event.timestamp);
    return cut >= 0 && index > 0 && cutOf(events[index - 1].timestamp) === cut;
  });
}

const WORKSPACE_WIDTH_DELTAS = ["sidebarWidthDelta", "previewDockWidthDelta"] as const;

/** Whether replay, going from `from` to `to`, opens another file or project. */
function opensAnotherModel(from: WorkspaceRecordingSnapshot, to: WorkspaceRecordingSnapshot) {
  const pair = [
    { timestamp: 0, snapshot: from },
    { timestamp: 1, snapshot: to },
  ];
  return latestEditorModelBoundaryTime(pair, 1) === 1;
}

/**
 * `snapshot` with another file open, which names nothing but what `snapshot` holds: no
 * file open, or, when it has none open, the first of its own files. Null when it has
 * no file to open and none open.
 */
function withAnotherFileOpen(
  snapshot: WorkspaceRecordingSnapshot,
): WorkspaceRecordingSnapshot | null {
  const path = ["", ...Object.keys(snapshot.project.files)].find(
    (candidate) => candidate !== snapshot.activeFilePath,
  );
  return path === undefined ? null : { ...snapshot, activeFilePath: path };
}

/**
 * A cut's workspace events become its last one. The panel widths are recorded as
 * changes since the previous event, so the survivor carries the sum of the run's.
 *
 * A snapshot holds every file's text as it was when the event fired, and typing fires
 * none: text typed before the cut's last workspace event and deleted after it is still
 * in that snapshot. `lastFrameOfCut` is the editor's state at the cut's end. When that
 * frame is later than the surviving event it belongs to the snapshot's active file (a
 * file switch would have been a later event), so its text replaces that file's.
 *
 * Frames carry no file: replay gives a frame to the open file only when the frame is no
 * earlier than the workspace event that last opened another file or project
 * (latestEditorModelBoundaryTime). The survivor alone would move that event to its own
 * time, or remove it when the cut switches away and back, and replay would then skip
 * the cut's last frame where it showed it, or put another file's text in the open one.
 * So when the run opened the survivor's file or project, events are kept at the moment
 * it did: the survivor's state with another file open, when the survivor's file is the
 * one open before the cut (a switch away and back), then the survivor's state, unless
 * the survivor is itself stamped at that moment. A file is then opened there whatever
 * was open before the cut.
 *
 * They are stamped at that one moment, and replay applies only the last of the events
 * stamped alike, so a playback tick or a seek inside the cut never shows the first on
 * its own: it lands on the state before the cut, the survivor's, or the survivor's
 * without its width changes. And they hold only the survivor's project and files, so
 * nothing from inside the cut is kept but the moment its file was opened: not another
 * project, nor the name of a file created and deleted inside it.
 */
export function squashWorkspaceEvents(
  events: readonly WorkspaceRecordingEvent[],
  cutOf: CutOf,
  lastFrameOfCut: (cut: number) => EditorFrame | undefined,
): WorkspaceRecordingEvent[] {
  // When replay last saw the editor's file or project change, at or before an event.
  const modelOpenedAt = (index: number) => latestEditorModelBoundaryTime(events, index);

  /**
   * The events before the survivor that make replay see its file opened when the
   * recording saw it, or none when the run opened no other file or project.
   */
  const openingEvents = (
    first: number,
    last: number,
    snapshot: WorkspaceRecordingSnapshot,
  ): WorkspaceRecordingEvent[] => {
    // The first event is never in a run, so `first - 1` is the event kept before it.
    const opened = modelOpenedAt(last);
    if (opened === null || opened === modelOpenedAt(first - 1)) return [];

    const {
      sidebarWidthDelta: _sidebarWidthDelta,
      previewDockWidthDelta: _previewDockWidthDelta,
      ...withoutWidths
    } = snapshot;
    // When the cut switched away and back, the survivor's file is the one open before
    // the cut, so another one is opened first.
    const away = opensAnotherModel(events[first - 1].snapshot, snapshot)
      ? null
      : withAnotherFileOpen(withoutWidths);
    const kept: WorkspaceRecordingEvent[] = away ? [{ timestamp: opened, snapshot: away }] : [];
    // A survivor stamped later is in the model opened at `opened`, and must not open it
    // again at its own time.
    if (events[last].timestamp !== opened) {
      kept.push({ timestamp: opened, snapshot: withoutWidths });
    }
    return kept;
  };

  const squashRun = (first: number, last: number, cut: number): WorkspaceRecordingEvent[] => {
    const survivor = events[last];
    let snapshot = survivor.snapshot;

    for (const key of WORKSPACE_WIDTH_DELTAS) {
      let total = 0;
      let recorded = false;
      for (let index = first; index <= last; index += 1) {
        const delta = events[index].snapshot[key];
        if (typeof delta === "number" && Number.isFinite(delta)) {
          total += delta;
          recorded = true;
        }
      }
      if (recorded && snapshot[key] !== total) snapshot = { ...snapshot, [key]: total };
    }

    const frame = lastFrameOfCut(cut);
    if (frame && frame.timestamp > survivor.timestamp) {
      snapshot = withFileContent(snapshot, snapshot.activeFilePath, frame.state.content);
    }

    return [
      ...openingEvents(first, last, snapshot),
      snapshot === survivor.snapshot ? survivor : { ...survivor, snapshot },
    ];
  };
  return squashCutRuns(events, cutOf, squashRun, { keepFirst: true });
}

/** A cut's runtime events become one checkpoint of the state they resolve to. */
export function squashRuntimeEvents(
  events: RuntimeRecordingEvent[],
  cutOf: CutOf,
): RuntimeRecordingEvent[] {
  const squashRun = (first: number, last: number): RuntimeRecordingEvent[] => {
    const snapshot = first === last ? null : resolveRuntimeSnapshotAt(events, last);
    return snapshot
      ? [{ timestamp: events[last].timestamp, snapshot }]
      : events.slice(first, last + 1);
  };
  return squashCutRuns(events, cutOf, squashRun, { keepFirst: true });
}

function foldChatEvent(state: ChatFoldState, { event }: ChatRecordingEvent): ChatFoldState {
  return event.k === "checkpoint"
    ? { items: event.state.items, status: event.state.status, draft: event.state.draft ?? "" }
    : applyChatDelta(state, event);
}

/**
 * A cut's chat events become one checkpoint of the transcript and prompt draft they
 * fold to, so a draft typed and cleared, or a turn sent and removed, is gone.
 *
 * A track that does not fold (a text delta that no longer applies to its message) is
 * returned as it was recorded: replay skips such an event, and an edit must not fail
 * where playback does not.
 */
export function squashChatEvents(
  events: readonly ChatRecordingEvent[],
  cutOf: CutOf,
): ChatRecordingEvent[] {
  if (!hasRunToSquash(events, cutOf)) return events.slice();

  let state = INITIAL_CHAT_FOLD_STATE;
  try {
    return squashCutRuns(
      events,
      cutOf,
      (first, last) => {
        for (let index = first; index <= last; index += 1) {
          state = foldChatEvent(state, events[index]);
        }
        if (first === last) return [events[first]];
        const { items, status, draft } = state;
        return [
          {
            timestamp: events[last].timestamp,
            event: { k: "checkpoint", state: { items, status, draft } },
          },
        ];
      },
      {
        passThrough: (event) => {
          state = foldChatEvent(state, event);
        },
      },
    );
  } catch {
    return events.slice();
  }
}

/**
 * A cut's whiteboard events become the one delta that takes the scene before the cut
 * to the scene after it. An element created and deleted inside the cut is left out:
 * a deleted element stays in the scene with everything it held, and no viewer of the
 * edited recording ever sees it.
 *
 * The delta is checked against the scene the run itself folds to, and the run is
 * kept as it was if they differ (elements with no `index` order by arrival).
 */
export function squashWhiteboardEvents(
  events: readonly WhiteboardEvent[],
  cutOf: CutOf,
): WhiteboardEvent[] {
  if (!hasRunToSquash(events, cutOf)) return events.slice();

  // The scene the squashed track has reached, which is what later events build on.
  let scene: WhiteboardSceneState = EMPTY_WHITEBOARD_SCENE;
  return squashCutRuns(
    events,
    cutOf,
    (first, last) => {
      const before = scene;
      let after = before;
      for (let index = first; index <= last; index += 1) {
        after = applyWhiteboardEvent(after, events[index]);
      }
      scene = after;
      if (first === last) return [events[first]];

      const existedBefore = new Set(before.elements.map((element) => element.id));
      const neverSeen = (element: { id: string; isDeleted: boolean }) =>
        element.isDeleted && !existedBefore.has(element.id);
      const delta = deriveWhiteboardDelta(before.elements, after.elements);
      const upserts = delta.upserts.filter((element) => !neverSeen(element));

      const squashed: WhiteboardEvent = { timestamp: events[last].timestamp };
      if (upserts.length > 0) squashed.upserts = upserts;
      if (delta.removedIds.length > 0) squashed.removedIds = delta.removedIds;
      if (after.view !== before.view) squashed.view = after.view;
      if (after.isOpen !== before.isOpen) squashed.isOpen = after.isOpen;
      if (after.isMaximized !== before.isMaximized) squashed.isMaximized = after.isMaximized;

      const reached = applyWhiteboardEvent(before, squashed);
      const expected = after.elements.filter((element) => !neverSeen(element));
      const matches =
        reached.elements.length === expected.length &&
        reached.elements.every((element, index) => element === expected[index]);
      if (!matches) return events.slice(first, last + 1);

      scene = reached;
      // A run that left the board as it found it leaves nothing to record.
      return Object.keys(squashed).length > 1 ? [squashed] : [];
    },
    {
      passThrough: (event) => {
        scene = applyWhiteboardEvent(scene, event);
      },
    },
  );
}
