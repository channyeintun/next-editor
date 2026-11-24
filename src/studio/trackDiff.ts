import type { CursorRecordingEvent, EditorFrame, Recording } from "../core/src";
import { resolveRuntimeSnapshotAt } from "../core/src/runtimeTrack";
import { isKeyframe } from "../core/src/utils/deltaTypes";
import { normalizeEditorFrame } from "../core/src/utils/editorState";
import { applyFrameDeltaToNormalized } from "../core/src/utils/frameDelta";
import { isWorkspaceTextFile, type WorkspaceRecordingSnapshot } from "../core/src/workspace";
import { canonicalJson } from "./hash";
import { timingStatsOf, type TimingStats } from "./report";

/**
 * Track-by-track comparison of two decoded recordings of one lesson, for
 * example a render on the real clock and one on a virtual clock.
 *
 * The repeatability check (compare.ts) looks at action starts, the final
 * workspace and the final console only. This module looks at every track a
 * viewer sees, change by change: each recording is reduced, per track, to the
 * ordered list of what a viewer would see change. The two lists must hold the
 * same changes in the same order; only the time of the k-th change may differ,
 * within a tolerance. Counts of raw samples are never compared, because a real
 * and a virtual render sample the pointer and the editor at different rates.
 *
 * Pure: no DOM, no clock, no I/O.
 */

export type TrackName =
  | "editor"
  | "workspace"
  | "runtime"
  | "whiteboard"
  | "slides"
  | "cursor"
  | "captions"
  | "chapters"
  | "duration";

export interface TrackDiffOptions {
  /** Largest allowed p95 of |time in a − time in b| over a track's matched changes. */
  p95Ms: number;
  /** Largest allowed single |time in a − time in b| in a track. */
  maxMs: number;
  /** Largest allowed distance between the two pointer paths, and between two rest points. */
  cursorDistancePx: number;
  /** Largest allowed |duration a − duration b|. */
  durationMs: number;
  /**
   * A pause between two pointer samples longer than this ends a run of motion.
   * Tween steps are 16 ms apart; the shortest rest the studio makes before a
   * press is 220 ms.
   */
  cursorRestGapMs: number;
}

export const DEFAULT_TRACK_DIFF_OPTIONS: TrackDiffOptions = {
  p95Ms: 150,
  maxMs: 500,
  cursorDistancePx: 4,
  durationMs: 100,
  cursorRestGapMs: 120,
};

/** One side of a difference: where it is and what it shows. */
export interface TrackDiffSide {
  timeMs: number;
  description: string;
}

export interface TrackDifference {
  /** Index of the change in the reduced list (not in the raw track). */
  index: number;
  /** content: the k-th changes differ; missing: one side has fewer; time / distance: beyond tolerance. */
  reason: "content" | "missing" | "time" | "distance";
  a: TrackDiffSide | null;
  b: TrackDiffSide | null;
  /** Where inside the change the two sides part, when that can be said briefly. */
  detail?: string;
}

export interface TrackComparison {
  track: TrackName;
  equal: boolean;
  /** Changes on each side after reduction. */
  counts: { a: number; b: number };
  /** |time a − time b| over the changes both sides share, up to the first content difference. */
  timing: TimingStats | null;
  /** Cursor only: the greatest distance between the two paths over the shared runs. */
  maxDistancePx?: number;
  firstDifference: TrackDifference | null;
}

export interface RecordingDiff {
  equal: boolean;
  tracks: TrackComparison[];
}

interface Point {
  x: number;
  y: number;
}

/** One change a viewer would see. */
interface TrackItem {
  /** The times this change carries (a caption cue has a start and an end). */
  timesMs: number[];
  /** Equal keys mean the same change. */
  key: string;
  description: string;
  /** For a pointer run: its path sampled at fixed fractions, ending where it rests. */
  path?: Point[];
  /** What `explain` reads to say where two different changes part. */
  content?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A short, stable label for long text (FNV-1a). For display only; keys hold the text itself. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clip(text: string, length = 40): string {
  const flat = text.replace(/\n/g, "⏎");
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** Where two texts first part, as line:column and a little of each side. */
function explainText(a: string, b: string): string {
  let offset = 0;
  while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
  const before = a.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `text parts at ${line}:${column}: "${clip(a.slice(offset), 24)}" vs "${clip(b.slice(offset), 24)}"`;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathDistance(a: Point[], b: Point[]): number {
  let worst = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    worst = Math.max(worst, distance(a[index], b[index]));
  }
  return worst;
}

/** Drop consecutive items with the same key: the later one changed nothing a viewer sees. */
function withoutRepeats(items: TrackItem[]): TrackItem[] {
  const kept: TrackItem[] = [];
  for (const item of items) {
    if (kept.length === 0 || kept[kept.length - 1].key !== item.key) kept.push(item);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Reducing each track to the changes a viewer sees
// ---------------------------------------------------------------------------

/**
 * Monaco stores the vertical scroll as the first visible line and that line's
 * offset from the top; the horizontal one as scrollLeft.
 */
function editorScrollOf(frame: EditorFrame): { top: string; left: number } {
  const view = (frame.state.viewState as { viewState?: Record<string, unknown> } | null)?.viewState;
  if (!view) return { top: "-", left: 0 };
  const left = typeof view.scrollLeft === "number" ? view.scrollLeft : 0;
  if (typeof view.scrollTop === "number") return { top: String(view.scrollTop), left };
  const first = view.firstPosition as { lineNumber?: number } | undefined;
  const deltaTop = typeof view.firstPositionDeltaTop === "number" ? view.firstPositionDeltaTop : 0;
  return { top: `line ${first?.lineNumber ?? 1}${deltaTop ? ` ${deltaTop}px` : ""}`, left };
}

/**
 * Every editor state, in order, keeping only the frames where the content, the
 * selection, the scroll or the slide shown changed. A frame that only moved the
 * pointer is not an editor change.
 */
function editorItems(recording: Recording): TrackItem[] {
  const items: TrackItem[] = [];
  let current: EditorFrame | null = null;
  recording.frames.forEach((frame, index) => {
    // The same forward walk reconstructFrameAtIndex makes, kept running so
    // each frame costs one delta instead of a walk from its keyframe.
    current = isKeyframe(frame)
      ? normalizeEditorFrame(frame)
      : current
        ? applyFrameDeltaToNormalized(current, frame, index)
        : null;
    if (!current) return;
    const { content, selection, slideState, currentSlideIndex } = current.state;
    const scroll = editorScrollOf(current);
    const range = `${selection.selectionStartLineNumber}:${selection.selectionStartColumn}-${selection.positionLineNumber}:${selection.positionColumn}`;
    const slide = slideState
      ? `${slideState.isOpen ? "open" : "shut"}${slideState.isMaximized ? " max" : ""} ${slideState.currentSlideId ?? "-"}#${slideState.indexv ?? 0}`
      : "none";
    items.push({
      timesMs: [current.timestamp],
      key: canonicalJson({ content, range, scroll, slide, currentSlideIndex }),
      description: `${content.length} chars #${shortHash(content)}, sel ${range}, scroll top ${scroll.top} left ${scroll.left}, slide ${slide}${currentSlideIndex === undefined ? "" : ` @${currentSlideIndex}`}`,
      content,
    });
  });
  return withoutRepeats(items);
}

function textFilesOf(snapshot: WorkspaceRecordingSnapshot): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, file] of Object.entries(snapshot.project.files)) {
    if (isWorkspaceTextFile(file)) files[path] = file.content;
  }
  return files;
}

/** The open file, the text of every text file, and the folded folders, after each event. */
function workspaceItems(recording: Recording): TrackItem[] {
  return withoutRepeats(
    (recording.workspaceEvents ?? []).map((event) => {
      const files = canonicalJson(textFilesOf(event.snapshot));
      const collapsed = [...(event.snapshot.collapsedFolders ?? [])].sort();
      return {
        timesMs: [event.timestamp],
        key: canonicalJson({ active: event.snapshot.activeFilePath, files, collapsed }),
        description: `open ${event.snapshot.activeFilePath}, files #${shortHash(files)}, collapsed [${collapsed.join(", ")}]`,
        content: files,
      };
    }),
  );
}

/** The resolved console text, terminal output, status and dock layout after each event. */
function runtimeItems(recording: Recording): TrackItem[] {
  const events = recording.runtimeEvents ?? [];
  const items: TrackItem[] = [];
  events.forEach((event, index) => {
    const snapshot = resolveRuntimeSnapshotAt(events, index);
    if (!snapshot) return;
    const consoleText = (snapshot.consoleLines ?? []).join("\n");
    const terminals = (snapshot.terminalSessions ?? []).map((session) => [
      session.id,
      session.output,
    ]);
    const dock = [snapshot.activeTab, snapshot.isCollapsed, snapshot.isFullHeight];
    const lines = snapshot.consoleLines ?? [];
    items.push({
      timesMs: [event.timestamp],
      key: canonicalJson({ status: snapshot.status, consoleText, terminals, dock }),
      description: `${snapshot.status}, ${lines.length} console lines${lines.length ? ` (last "${clip(lines[lines.length - 1])}")` : ""}, ${terminals.length} terminals, dock ${dock.map(String).join("/")}`,
      content: [consoleText, ...terminals.map(([, output]) => output)].join("\n"),
    });
  });
  return withoutRepeats(items);
}

/** Elements added or changed (id and version), removed, and the board opened or maximized. */
function whiteboardItems(recording: Recording): TrackItem[] {
  const items: TrackItem[] = [];
  for (const event of recording.whiteboardEvents ?? []) {
    const upserts = (event.upserts ?? []).map((element) => `${element.id}@${element.version}`);
    const removed = [...(event.removedIds ?? [])].sort();
    upserts.sort();
    // A view-only event (a pan or zoom) is not part of the comparison.
    if (
      !upserts.length &&
      !removed.length &&
      event.isOpen === undefined &&
      event.isMaximized === undefined
    ) {
      continue;
    }
    const flags = [
      event.isOpen === undefined ? "" : event.isOpen ? "open" : "shut",
      event.isMaximized === undefined ? "" : event.isMaximized ? "max" : "min",
    ].filter(Boolean);
    items.push({
      timesMs: [event.timestamp],
      key: canonicalJson({ upserts, removed, flags }),
      description: `+${upserts.length} [${clip(upserts.join(" "), 48)}] -${removed.length}${removed.length ? ` [${clip(removed.join(" "), 32)}]` : ""}${flags.length ? ` ${flags.join(" ")}` : ""}`,
    });
  }
  return items;
}

function slideItems(recording: Recording): TrackItem[] {
  return (recording.slideEvents ?? []).map((event) => ({
    timesMs: [event.timestamp],
    key: `${event.type}:${event.slideId ?? ""}`,
    description: `${event.type}${event.slideId ? ` ${event.slideId}` : ""}`,
  }));
}

/** Fractions of a run at which the two paths are compared. */
const PATH_FRACTIONS = Array.from({ length: 21 }, (_, index) => index / 20);

/** The run's position at `fraction` of its time span (of its samples, when it has no span). */
function pointOnRun(run: CursorRecordingEvent[], fraction: number): Point {
  if (run.length === 1) return { x: run[0].x, y: run[0].y };
  const start = run[0].timestamp;
  const span = run[run.length - 1].timestamp - start;
  const at = (index: number) =>
    span > 0 ? (run[index].timestamp - start) / span : index / (run.length - 1);
  let index = 1;
  while (index < run.length - 1 && at(index) < fraction) index++;
  const from = run[index - 1];
  const to = run[index];
  const width = at(index) - at(index - 1);
  const share = width > 0 ? Math.min(1, Math.max(0, (fraction - at(index - 1)) / width)) : 1;
  return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
}

/**
 * The pointer as runs of motion. A run ends where the pointer rests: before a
 * pause longer than `restGapMs`, or where it is shown or hidden, or pressed or
 * released. A sample that repeats the last one (same spot, visibility and
 * buttons) changes nothing and is dropped. Each run is compared by its path
 * and by where it rests; the sample count inside a run is not.
 */
function cursorItems(recording: Recording, restGapMs: number): TrackItem[] {
  const runs: CursorRecordingEvent[][] = [];
  let run: CursorRecordingEvent[] = [];
  let lastTime = Number.NEGATIVE_INFINITY;
  // When the last repeat of the rest point was recorded.
  let repeatedAt: number | null = null;
  for (const sample of recording.cursorEvents ?? []) {
    const last = run[run.length - 1];
    const sameState =
      last && last.visible === sample.visible && (last.flags ?? 0) === (sample.flags ?? 0);
    if (sameState && last.x === sample.x && last.y === sample.y) {
      repeatedAt = sample.timestamp;
      continue;
    }
    if (!sameState) {
      if (run.length) runs.push(run);
      run = [sample];
    } else if (sample.timestamp - lastTime > restGapMs) {
      runs.push(run);
      // A move from rest starts at the rest point, whether or not its first
      // step was recorded there: a real render's first step is a hair off the
      // point, a virtual one's lands on it and repeats it. Starting every such
      // run at the rest point, at the time the move began, makes the two alike.
      const startedAt =
        repeatedAt !== null && sample.timestamp - repeatedAt <= restGapMs
          ? repeatedAt
          : sample.timestamp;
      run = [{ ...last, timestamp: startedAt }, sample];
    } else {
      // A repeat that was dropped still says the pointer stayed put until
      // then; without it the path would be drawn as a slow slide instead.
      if (repeatedAt !== null) run.push({ ...last, timestamp: repeatedAt });
      run.push(sample);
    }
    lastTime = sample.timestamp;
    repeatedAt = null;
  }
  if (run.length) runs.push(run);

  return runs.map((samples) => {
    const end = samples[samples.length - 1];
    const state = `${end.visible ? "shown" : "hidden"}${end.flags ? ` buttons ${end.flags}` : ""}`;
    return {
      timesMs: [end.timestamp],
      key: state,
      description: `rests at ${Math.round(end.x)},${Math.round(end.y)} ${state} after ${samples.length} samples`,
      path: PATH_FRACTIONS.map((fraction) => pointOnRun(samples, fraction)),
    };
  });
}

function captionItems(recording: Recording): TrackItem[] {
  return (recording.captions ?? []).flatMap((track) =>
    track.cues.map((cue) => ({
      timesMs: [cue.start, cue.end],
      key: `${track.id}:${cue.text}`,
      description: `${track.id} ${Math.round(cue.start)}–${Math.round(cue.end)} "${clip(cue.text)}"`,
    })),
  );
}

function chapterItems(recording: Recording): TrackItem[] {
  return (recording.chapters ?? []).map((chapter) => ({
    timesMs: [chapter.time],
    key: chapter.title,
    description: `"${clip(chapter.title)}"`,
  }));
}

// ---------------------------------------------------------------------------
// Comparing two reduced tracks
// ---------------------------------------------------------------------------

function sideOf(item: TrackItem | undefined): TrackDiffSide | null {
  return item ? { timeMs: Math.round(item.timesMs[0] ?? 0), description: item.description } : null;
}

function compareItems(
  track: TrackName,
  a: TrackItem[],
  b: TrackItem[],
  options: TrackDiffOptions,
): TrackComparison {
  const shared = Math.min(a.length, b.length);
  let firstDifference: TrackDifference | null = null;
  let maxDistancePx = 0;
  let matched = 0;

  for (; matched < shared; matched++) {
    const left = a[matched];
    const right = b[matched];
    if (left.key !== right.key) {
      firstDifference = {
        index: matched,
        reason: "content",
        a: sideOf(left),
        b: sideOf(right),
        detail:
          left.content !== undefined && right.content !== undefined
            ? explainText(left.content, right.content)
            : undefined,
      };
      break;
    }
    if (left.path && right.path) {
      const apart = pathDistance(left.path, right.path);
      maxDistancePx = Math.max(maxDistancePx, apart);
      if (apart > options.cursorDistancePx) {
        firstDifference = {
          index: matched,
          reason: "distance",
          a: sideOf(left),
          b: sideOf(right),
          detail: `paths up to ${apart.toFixed(1)}px apart (rest points ${distance(left.path[left.path.length - 1], right.path[right.path.length - 1]).toFixed(1)}px)`,
        };
        break;
      }
    }
  }
  if (!firstDifference && a.length !== b.length) {
    firstDifference = {
      index: shared,
      reason: "missing",
      a: sideOf(a[shared]),
      b: sideOf(b[shared]),
    };
  }

  // Times are compared over the changes both sides agree on.
  const deltasByItem = a.slice(0, matched).map((left, index) => {
    const right = b[index];
    const pairs = Math.min(left.timesMs.length, right.timesMs.length);
    let worst = 0;
    const deltas: number[] = [];
    for (let pair = 0; pair < pairs; pair++) {
      const delta = Math.abs(left.timesMs[pair] - right.timesMs[pair]);
      deltas.push(delta);
      worst = Math.max(worst, delta);
    }
    return { deltas, worst };
  });
  const timing = timingStatsOf(deltasByItem.flatMap((entry) => entry.deltas));
  const p95Failed = timing !== null && timing.p95Ms > options.p95Ms;
  const maxFailed = timing !== null && timing.maxMs > options.maxMs;
  if (!firstDifference && timing && (p95Failed || maxFailed)) {
    const limit = p95Failed ? options.p95Ms : options.maxMs;
    const index = deltasByItem.findIndex((entry) => entry.worst > limit);
    firstDifference = {
      index,
      reason: "time",
      a: sideOf(a[index]),
      b: sideOf(b[index]),
      detail: `${Math.round(deltasByItem[index].worst)}ms apart (p95 ${timing.p95Ms}ms, limit ${options.p95Ms}ms; max ${timing.maxMs}ms, limit ${options.maxMs}ms)`,
    };
  }

  return {
    track,
    equal: firstDifference === null,
    counts: { a: a.length, b: b.length },
    timing,
    ...(track === "cursor" ? { maxDistancePx: Math.round(maxDistancePx * 10) / 10 } : {}),
    firstDifference,
  };
}

function compareDuration(a: Recording, b: Recording, options: TrackDiffOptions): TrackComparison {
  const apart = Math.abs(a.duration - b.duration);
  const timing = timingStatsOf([apart]);
  const side = (recording: Recording): TrackDiffSide => ({
    timeMs: Math.round(recording.duration),
    description: `${Math.round(recording.duration)}ms`,
  });
  return {
    track: "duration",
    equal: apart <= options.durationMs,
    counts: { a: 1, b: 1 },
    timing,
    firstDifference:
      apart <= options.durationMs
        ? null
        : {
            index: 0,
            reason: "time",
            a: side(a),
            b: side(b),
            detail: `${Math.round(apart)}ms apart (limit ${options.durationMs}ms)`,
          },
  };
}

/** Compare two decoded recordings track by track. */
export function diffRecordings(
  a: Recording,
  b: Recording,
  overrides: Partial<TrackDiffOptions> = {},
): RecordingDiff {
  const options = { ...DEFAULT_TRACK_DIFF_OPTIONS, ...overrides };
  const reducers: [TrackName, (recording: Recording) => TrackItem[]][] = [
    ["editor", editorItems],
    ["workspace", workspaceItems],
    ["runtime", runtimeItems],
    ["whiteboard", whiteboardItems],
    ["slides", slideItems],
    ["cursor", (recording) => cursorItems(recording, options.cursorRestGapMs)],
    ["captions", captionItems],
    ["chapters", chapterItems],
  ];
  const tracks = reducers.map(([track, reduce]) =>
    compareItems(track, reduce(a), reduce(b), options),
  );
  tracks.push(compareDuration(a, b, options));
  return { equal: tracks.every((track) => track.equal), tracks };
}

/** Whether two recordings show the same thing, change by change, within the tolerances. */
export function isEqual(
  a: Recording,
  b: Recording,
  overrides: Partial<TrackDiffOptions> = {},
): boolean {
  return diffRecordings(a, b, overrides).equal;
}
