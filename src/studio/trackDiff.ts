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
 * within a tolerance, and changes on different tracks keep their order beyond
 * a small margin. Counts of raw samples are never compared, because a real
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
  | "duration"
  /** Not a track: the order of changes across tracks. */
  | "order";

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
   * press is 220 ms. The same gap ends a drag-select in the editor track: the
   * steps of one sweep are one pointer step apart.
   */
  cursorRestGapMs: number;
  /**
   * How far one pointer run may be slid in time against the other to bring
   * the two paths closest. Separate from `maxMs`: the slide only lines up two
   * paths for the distance check, and a whole move that is late by more than
   * this reads as a different path, not as a time.
   */
  cursorMaxShiftMs: number;
  /**
   * Two changes on different tracks this far apart in a must keep their order
   * in b. Closer than this, ordinary lateness of one track against another
   * may swap them.
   */
  orderMarginMs: number;
  /**
   * How far in time a pointer sample may sit from its match before its
   * distance counts. A real timer fires a few ms late (7 ms measured on a pen
   * stroke moving 1.5 px/ms, which reads as 10 px at the same instant though
   * both renders drew the same points). Less than one 16 ms pointer step, so a
   * step that is skipped or a different speed still shows as distance.
   */
  cursorTimeSlackMs: number;
}

/**
 * Set from four pairs of a real and a full-speed render (go-error-values,
 * next-editor-state-machine, haskell-crash-course, clock-check-slides; Chrome
 * on an 8 GB M1, 2026-11-24), each bound the worst value measured plus the
 * headroom given. A real render that stalls (one 475 ms page stall was seen)
 * fails and is rendered again; it is not absorbed.
 * - Times: worst 56 ms on any track (the real fixture run's latency, and the
 *   real render's first pen frame), so max 100 (+44). The p95 is the same 56
 *   on a short track, where p95 is the worst; 75 (+19) still lets no more than
 *   one change in twenty sit between 75 and 100 ms off.
 * - Pointer: paths at most 1.0 px apart, so 2 (+1). The best time shift was
 *   48 ms (a pen stroke that began 52.7 ms later), so 100 (+52), no more than
 *   any change of a track may be late.
 * - Order: two changes on different tracks swapped when 12 ms apart at most,
 *   so 50 (+38).
 * - Duration: 0 ms apart in every pair; 100 is one change's worth.
 */
export const DEFAULT_TRACK_DIFF_OPTIONS: TrackDiffOptions = {
  p95Ms: 75,
  maxMs: 100,
  cursorDistancePx: 2,
  durationMs: 100,
  cursorRestGapMs: 120,
  cursorTimeSlackMs: 10,
  cursorMaxShiftMs: 100,
  orderMarginMs: 50,
};

/** One side of a difference: where it is and what it shows. */
export interface TrackDiffSide {
  timeMs: number;
  description: string;
}

export interface TrackDifference {
  /** Index of the change in the reduced list (not in the raw track). */
  index: number;
  /**
   * content: the k-th changes differ; missing: one side has fewer; time /
   * distance: beyond tolerance; order: two changes on different tracks swap.
   */
  reason: "content" | "missing" | "time" | "distance" | "order";
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
  /** For a pointer run: its samples, from where it left rest to where it rests. */
  run?: CursorRecordingEvent[];
  /** What `explain` reads to say where two different changes part. */
  content?: string;
  /** Editor only: equal for the steps of one drag-select (all but the selection's moving end). */
  sweep?: string;
  /** Editor only: the selection is a bare caret, with nothing highlighted. */
  caret?: boolean;
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

/**
 * Where a run of motion has the pointer at `timeMs`: on a straight line
 * between the two samples around it, at its first point before it starts and
 * at its last after it ends (the pointer rests there).
 */
function positionAt(run: readonly CursorRecordingEvent[], timeMs: number): Point {
  const first = run[0];
  const last = run[run.length - 1];
  if (timeMs <= first.timestamp) return { x: first.x, y: first.y };
  if (timeMs >= last.timestamp) return { x: last.x, y: last.y };
  let low = 0;
  let high = run.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (run[middle].timestamp <= timeMs) low = middle;
    else high = middle;
  }
  const from = run[low];
  const to = run[high];
  const width = to.timestamp - from.timestamp;
  const share = width > 0 ? (timeMs - from.timestamp) / width : 1;
  return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const share =
    length > 0
      ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length))
      : 0;
  return distance(point, { x: from.x + dx * share, y: from.y + dy * share });
}

/** The index of the first sample after `timeMs`, or the run's length. */
function firstAfter(run: readonly CursorRecordingEvent[], timeMs: number): number {
  let low = 0;
  let high = run.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (run[middle].timestamp <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** How close `run` comes to `point` while it is within `slackMs` of `timeMs`. */
function distanceNear(
  point: Point,
  run: readonly CursorRecordingEvent[],
  timeMs: number,
  slackMs: number,
): number {
  if (slackMs <= 0) return distance(point, positionAt(run, timeMs));
  // Only the samples inside the window, found by search: a run is probed at
  // every one of its samples, so a scan of the whole run per probe would make
  // a long pen stroke cost its length squared for every time shift tried.
  let previous = positionAt(run, timeMs - slackMs);
  let nearest = Number.POSITIVE_INFINITY;
  for (
    let index = firstAfter(run, timeMs - slackMs);
    index < run.length && run[index].timestamp < timeMs + slackMs;
    index++
  ) {
    nearest = Math.min(nearest, distanceToSegment(point, previous, run[index]));
    previous = run[index];
  }
  return Math.min(nearest, distanceToSegment(point, previous, positionAt(run, timeMs + slackMs)));
}

/** A point of a run and when it was there. */
interface Probe extends Point {
  timeMs: number;
}

/**
 * Where a run is checked against the other: at every sample, since each is a
 * point a viewer saw, and at fixed fractions of its span, which also cover
 * the stretches between two far-apart samples of the other run.
 */
function probesOf(run: readonly CursorRecordingEvent[]): Probe[] {
  const start = run[0].timestamp;
  const span = run[run.length - 1].timestamp - start;
  return [
    ...run.map((sample) => ({ x: sample.x, y: sample.y, timeMs: sample.timestamp })),
    ...PATH_FRACTIONS.map((fraction) => {
      const timeMs = start + span * fraction;
      return { ...positionAt(run, timeMs), timeMs };
    }),
  ];
}

/**
 * The farthest the two runs are apart when b is read `shiftMs` later than a,
 * each point matched anywhere on the other run within `slackMs` of its time.
 */
function apartWithShift(
  a: readonly CursorRecordingEvent[],
  b: readonly CursorRecordingEvent[],
  probesA: readonly Probe[],
  probesB: readonly Probe[],
  shiftMs: number,
  slackMs: number,
): number {
  let worst = 0;
  for (const probe of probesA) {
    worst = Math.max(worst, distanceNear(probe, b, probe.timeMs + shiftMs, slackMs));
  }
  for (const probe of probesB) {
    worst = Math.max(worst, distanceNear(probe, a, probe.timeMs - shiftMs, slackMs));
  }
  return worst;
}

/**
 * How far apart two runs of motion are, with the second moved in time by
 * whatever constant amount, up to `maxShiftMs`, brings them closest.
 *
 * A run is read on its own timeline, not stretched over its first and last
 * recorded change: the recorder keeps only samples that move the pointer, and
 * an eased start or landing stays on the same rounded pixel for several steps,
 * so where the first and last visible change fall depends on how the steps
 * happen to land (16 ms apart on a virtual clock, 17 to 21 ms on a real one).
 * Stretching two such runs over their visible spans compares points up to a
 * step apart in time, which at drag speed is several pixels, though both
 * draw the same motion. One constant shift absorbs a run that simply started
 * a little later; a different route, speed or landing still shows as distance.
 */
function runsApart(
  a: readonly CursorRecordingEvent[],
  b: readonly CursorRecordingEvent[],
  maxShiftMs: number,
  slackMs: number,
): number {
  const probesA = probesOf(a);
  const probesB = probesOf(b);
  const coarseStepMs = 2;
  const within = (shift: number) => Math.abs(shift) <= maxShiftMs;
  let bestShift = 0;
  let best = apartWithShift(a, b, probesA, probesB, 0, slackMs);
  const tryShift = (shift: number) => {
    if (!within(shift)) return;
    const apart = apartWithShift(a, b, probesA, probesB, shift, slackMs);
    if (apart < best) {
      best = apart;
      bestShift = shift;
    }
  };
  // The run simply starting, or ending, that much later is tried exactly: a
  // press and the first step of a drag can be recorded in the same
  // millisecond, a jump that a shift off by a fraction of a millisecond reads
  // as tens of pixels apart.
  tryShift(b[0].timestamp - a[0].timestamp);
  tryShift(b[b.length - 1].timestamp - a[a.length - 1].timestamp);
  for (let shift = -maxShiftMs; shift <= maxShiftMs; shift += coarseStepMs) tryShift(shift);
  const around = bestShift;
  for (let shift = around - coarseStepMs; shift <= around + coarseStepMs; shift += 0.25) {
    tryShift(shift);
  }
  return best;
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
function editorItems(recording: Recording, sweepGapMs: number): TrackItem[] {
  const items: TrackItem[] = [];
  let current: EditorFrame | null = null;
  // With a slide track, playback shows slides from it and ignores the slide
  // state a frame carries (frameReplay's mirrorFrameSlideState). That state is
  // only copied into whichever frame is captured next, which in a real render
  // can be the pointer's next move seconds later, so it is not compared here;
  // the slides track compares what a viewer sees.
  const slidesFromTrack = (recording.slideEvents?.length ?? 0) > 0;
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
    const slide = slidesFromTrack
      ? "track"
      : slideState
        ? `${slideState.isOpen ? "open" : "shut"}${slideState.isMaximized ? " max" : ""} ${slideState.currentSlideId ?? "-"}#${slideState.indexv ?? 0}`
        : "none";
    const slideIndex = slidesFromTrack ? undefined : currentSlideIndex;
    items.push({
      // When the change was first shown and when it was last: the same for a
      // single frame, the start and the landing for a merged drag-select.
      timesMs: [current.timestamp, current.timestamp],
      key: canonicalJson({ content, range, scroll, slide, slideIndex }),
      sweep: canonicalJson({
        content,
        anchor: `${selection.selectionStartLineNumber}:${selection.selectionStartColumn}`,
        scroll,
        slide,
        slideIndex,
      }),
      description: `${content.length} chars #${shortHash(content)}, sel ${range}, scroll top ${scroll.top} left ${scroll.left}, slide ${slide}${slideIndex === undefined ? "" : ` @${slideIndex}`}`,
      content,
      caret:
        selection.selectionStartLineNumber === selection.positionLineNumber &&
        selection.selectionStartColumn === selection.positionColumn,
    });
  });
  return withoutSweepSteps(withoutRepeats(items), sweepGapMs);
}

/**
 * A drag-select as one change: the selection it lands on, from when its
 * highlight first showed to when it landed. While the button is held the
 * highlight follows the character under the pointer at each step, and which
 * characters the steps hit depends on when they fire: 16 ms apart on a
 * virtual clock, 17 to 21 ms on a real one, so the two renders pass through
 * different in-between selections (haskell-crash-course: 4:5 against 4:6) on
 * the same sweep. The sweep itself is the pointer's path, which the cursor
 * track compares.
 *
 * Only the steps of one sweep merge: a highlight that grows from an existing
 * one, at most `gapMs` after the last step. A caret is not the start of a
 * sweep, and a selection held for a while is a change of its own, so how
 * long a caret or a highlight was shown is still compared.
 */
function withoutSweepSteps(items: TrackItem[], gapMs: number): TrackItem[] {
  const kept: TrackItem[] = [];
  for (const item of items) {
    const last = kept[kept.length - 1];
    if (
      last &&
      last.sweep !== undefined &&
      last.sweep === item.sweep &&
      !last.caret &&
      item.timesMs[0] - last.timesMs[last.timesMs.length - 1] <= gapMs
    ) {
      kept[kept.length - 1] = { ...item, timesMs: [last.timesMs[0], item.timesMs[1]] };
    } else {
      kept.push(item);
    }
  }
  return kept;
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
    } else if (sample.visible && sample.timestamp - lastTime > restGapMs) {
      // Only a shown pointer rests where a viewer sees it. A hidden one that is
      // placed twice (at 0 and again 240 ms later in a real render, both at 0
      // on a virtual clock) is one wait, seen only where it reappears.
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

  return runs.map((samples, index) => {
    const end = samples[samples.length - 1];
    const state = `${end.visible ? "shown" : "hidden"}${end.flags ? ` buttons ${end.flags}` : ""}`;
    const hiddenAfterShown = !end.visible && index > 0 && runs[index - 1][0].visible;
    return {
      // A hidden pointer's time is when a viewer sees it vanish, its first
      // sample, if it was shown just before. When a pointer that has been
      // hidden all along is placed is not seen; the time a viewer sees is
      // where it reappears, the start of the next run.
      timesMs: end.visible ? [end.timestamp] : hiddenAfterShown ? [samples[0].timestamp] : [],
      key: state,
      description: `rests at ${Math.round(end.x)},${Math.round(end.y)} ${state} after ${samples.length} samples`,
      // A hidden pointer's moves are not seen; only where it waits to reappear is.
      run: end.visible ? samples : [end],
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
  if (!item) return null;
  const timeMs = item.timesMs[0] ?? item.run?.[item.run.length - 1]?.timestamp ?? 0;
  return { timeMs: Math.round(timeMs), description: item.description };
}

/** A track's comparison, and how many of its changes both sides share before they part. */
interface ItemsCompared {
  comparison: TrackComparison;
  matched: number;
}

function compareItems(
  track: TrackName,
  a: TrackItem[],
  b: TrackItem[],
  options: TrackDiffOptions,
): ItemsCompared {
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
    if (left.run && right.run) {
      const apart = runsApart(
        left.run,
        right.run,
        options.cursorMaxShiftMs,
        options.cursorTimeSlackMs,
      );
      maxDistancePx = Math.max(maxDistancePx, apart);
      if (apart > options.cursorDistancePx) {
        firstDifference = {
          index: matched,
          reason: "distance",
          a: sideOf(left),
          b: sideOf(right),
          detail: `paths up to ${apart.toFixed(1)}px apart (rest points ${distance(left.run[left.run.length - 1], right.run[right.run.length - 1]).toFixed(1)}px)`,
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
    comparison: {
      track,
      equal: firstDifference === null,
      counts: { a: a.length, b: b.length },
      timing,
      ...(track === "cursor" ? { maxDistancePx: Math.round(maxDistancePx * 10) / 10 } : {}),
      firstDifference,
    },
    matched,
  };
}

/** One time of one shared change, on both sides. */
interface TimedChange {
  track: TrackName;
  index: number;
  item: TrackItem;
  aMs: number;
  bMs: number;
}

function describeChange(change: TimedChange): string {
  return `${change.track} #${change.index} ${change.item.description}`;
}

/**
 * The order of changes across tracks. Each track is compared on its own, so
 * within its tolerance a console line could land before the keystroke that
 * produced it, or the pointer arrive after the click it makes. Every time of
 * every shared change is put on one line in a's order; a change that comes
 * more than `marginMs` after one on another track in a must not come before
 * it in b.
 */
function compareOrder(changes: TimedChange[], marginMs: number): TrackComparison {
  const byA = [...changes].sort((left, right) => left.aMs - right.aMs);
  // Of the changes at least `marginMs` earlier in a: the one latest in b,
  // and the one latest in b on a track other than that one's.
  let latest: TimedChange | null = null;
  let latestElsewhere: TimedChange | null = null;
  let earlier = 0;
  let firstDifference: TrackDifference | null = null;
  for (const change of byA) {
    while (earlier < byA.length && byA[earlier].aMs < change.aMs - marginMs) {
      const added = byA[earlier++];
      if (!latest || added.track === latest.track) {
        if (!latest || added.bMs > latest.bMs) latest = added;
      } else if (added.bMs > latest.bMs) {
        latestElsewhere = latest;
        latest = added;
      } else if (!latestElsewhere || added.bMs > latestElsewhere.bMs) {
        latestElsewhere = added;
      }
    }
    const before = latest && latest.track !== change.track ? latest : latestElsewhere;
    if (before && before.bMs > change.bMs) {
      firstDifference = {
        index: change.index,
        reason: "order",
        a: {
          timeMs: Math.round(change.aMs),
          description: `${describeChange(change)}, ${Math.round(change.aMs - before.aMs)}ms after ${describeChange(before)}`,
        },
        b: {
          timeMs: Math.round(change.bMs),
          description: `${describeChange(change)}, ${Math.round(before.bMs - change.bMs)}ms before ${describeChange(before)}`,
        },
        detail: `${change.track} and ${before.track} swap order (margin ${marginMs}ms)`,
      };
      break;
    }
  }
  return {
    track: "order",
    equal: firstDifference === null,
    counts: { a: changes.length, b: changes.length },
    timing: null,
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
    ["editor", (recording) => editorItems(recording, options.cursorRestGapMs)],
    ["workspace", workspaceItems],
    ["runtime", runtimeItems],
    ["whiteboard", whiteboardItems],
    ["slides", slideItems],
    ["cursor", (recording) => cursorItems(recording, options.cursorRestGapMs)],
    ["captions", captionItems],
    ["chapters", chapterItems],
  ];
  const changes: TimedChange[] = [];
  const tracks = reducers.map(([track, reduce]) => {
    const itemsA = reduce(a);
    const itemsB = reduce(b);
    const { comparison, matched } = compareItems(track, itemsA, itemsB, options);
    for (let index = 0; index < matched; index++) {
      const item = itemsA[index];
      const timesB = itemsB[index].timesMs;
      const pairs = Math.min(item.timesMs.length, timesB.length);
      for (let pair = 0; pair < pairs; pair++) {
        changes.push({ track, index, item, aMs: item.timesMs[pair], bMs: timesB[pair] });
      }
    }
    return comparison;
  });
  tracks.push(compareDuration(a, b, options));
  tracks.push(compareOrder(changes, options.orderMarginMs));
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
