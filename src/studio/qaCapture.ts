import type { Recording } from "../core/src";
import { latestEditorModelBoundaryTime } from "../core/src/machine/frameReplay";
import { RECORDING_TRACK_NAMES } from "../core/src/machine/recordingAssembly";
import { getSlideReplayResult } from "../core/src/machine/replayState/slide";
import { getWhiteboardReplayResult } from "../core/src/machine/replayState/whiteboard";
import { resolveLatestRuntimeSnapshot } from "../core/src/runtimeTrack";
import type { SlideEvent, SlidePreviewState } from "../core/src/slides";
import { normalizeRecordingData } from "../core/src/utils/editorState";
import { reconstructFrameAtIndex } from "../core/src/utils/frameDelta";
import { findTimedEventIndexAtOrBefore } from "../core/src/utils/timedIndex";
import { EMPTY_WHITEBOARD_SCENE, type WhiteboardEvent } from "../core/src/whiteboard";
import { isSlideEventKeptOnDecode } from "../storage/streamingRecordingCodec/decode";
import {
  areWorkspaceFilesEqual,
  isWorkspaceTextFile,
  type WorkspaceFile,
} from "../core/src/workspace";
import type {
  EditorReading,
  StageSends,
  StudioActionEndReading,
  StudioPageReading,
} from "./driver";
import type { RenderClockKind } from "./renderClock";
import type { ActionReceipt, StudioCheckResult } from "./report";

/**
 * The capture checks of the artifact QA (qa.ts): what the recording holds
 * against what the render performed and what the page showed. The other
 * gates check the recording against itself or the plan; these use what only
 * the render knows (the events the driver sent, and readings of the page
 * taken during the take), so they can catch a recorder that dropped, added or
 * mis-timed something.
 *
 * Every check here is advisory: it reports a failure as a warning and never
 * fails the render, until it has run clean on real lessons.
 *
 * What they cannot see: a recorder that captured faithfully something that
 * should not have happened (a preview that really reloaded), the preview's
 * DOM recording (only a browser replays it), and whiteboard elements a person
 * draws by hand (the studio never does).
 */

/**
 * How long after an action's end the recording may take to hold what the
 * action left. On the virtual clock time moves only when the render sleeps,
 * so anything the action caused is stamped at its end. On the real clock some
 * capture runs a beat later (a React effect after a commit), so a short window
 * is allowed; the window also never runs past the next action's start.
 */
export const ACTION_END_WINDOW_MS = {
  real: 250,
  virtual: 0,
} as const satisfies Record<RenderClockKind, number>;

/** The page as one action left it, read the moment it ended. */
export interface ActionEndObservation {
  actionId: string;
  endedAtMs: number;
  reading: StudioActionEndReading;
}

/** What the render saw while it performed, for the capture checks. */
export interface CaptureObservations {
  clock: RenderClockKind;
  /** Every action's receipt: the windows between actions come from their starts. */
  receipts: readonly ActionReceipt[];
  actionEnds: readonly ActionEndObservation[];
  /** The page read once, right before the take stopped; null when it was not read. */
  endOfTake: StudioPageReading | null;
  stageSends: StageSends;
}

export interface CaptureGateInput {
  /** The recording that was encoded, compared with the decoded one track by track. */
  recording: Recording;
  /** The decoded artifact, or null when it did not decode. */
  decoded: Recording | null;
  /** What every other comparison reads: the decoded artifact when it decoded. */
  artifactRecording: Recording;
  observations: CaptureObservations;
}

export function captureGateChecks({
  recording,
  decoded,
  artifactRecording,
  observations,
}: CaptureGateInput): StudioCheckResult[] {
  const checks: Omit<StudioCheckResult, "advisory">[] = [
    provenanceCheck(
      "capture.slides.provenance",
      artifactRecording.slideEvents ?? [],
      observations.stageSends.slideEvents,
      describeSlideEvent,
    ),
    provenanceCheck(
      "capture.whiteboard.provenance",
      artifactRecording.whiteboardEvents ?? [],
      observations.stageSends.whiteboardEvents,
      describeWhiteboardEvent,
    ),
    roundTripCheck(recording, decoded),
    ...endOfTakeChecks(artifactRecording, observations),
    ...actionEndChecks(artifactRecording, observations),
  ];
  return checks.map((check) => ({ ...check, advisory: true }));
}

// ---------------------------------------------------------------------------
// Comparing values
// ---------------------------------------------------------------------------

function clip(text: string, length = 60): string {
  const flat = text.replace(/\n/g, "⏎");
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (typeof value === "string") return JSON.stringify(clip(value, 40));
  try {
    return clip(JSON.stringify(value) ?? String(value), 40);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

/**
 * Where two plain-data values first differ, as a path and both sides, or null
 * when they are equal. It treats a value the way the recording file stores
 * it: a key holding undefined is no key (the encoder skips it), an undefined
 * array item is null, and binary data is compared byte by byte.
 */
export function firstDifference(left: unknown, right: unknown, path: string): string | null {
  if (left === right) return null;
  if (Number.isNaN(left) && Number.isNaN(right)) return null;
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    if (leftBytes.length !== rightBytes.length) {
      return `${path}: ${leftBytes.length} bytes vs ${rightBytes.length}`;
    }
    const at = leftBytes.findIndex((byte, index) => byte !== rightBytes[index]);
    return at === -1 ? null : `${path}: bytes differ at ${at}`;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${path}: ${left.length} items vs ${right.length}`;
    }
    for (let index = 0; index < left.length; index++) {
      const difference = firstDifference(
        left[index] ?? null,
        right[index] ?? null,
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return `${path}: ${describeValue(left)} vs ${describeValue(right)}`;
}

/** Where two texts first part, as line:column. */
function textPartsAt(left: string, right: string): string {
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset++;
  const before = left.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `${line}:${column}`;
}

/** Joins the first few problems into a detail, saying how many more there were. */
function listed(problems: readonly string[], shown = 3): string {
  const head = problems.slice(0, shown).join("; ");
  return problems.length > shown ? `${head}; and ${problems.length - shown} more` : head;
}

// ---------------------------------------------------------------------------
// Provenance: the stage's events are the ones the driver sent
// ---------------------------------------------------------------------------

/**
 * How far past a missing event the walk looks for the recorded one. A dropped
 * event shows up as a later sent event recorded next; anything not found this
 * close is an event the driver never sent.
 */
const PROVENANCE_LOOKAHEAD = 64;

function describeSlideEvent(event: SlideEvent): string {
  return `${event.type}${event.slideId ? ` ${event.slideId}` : ""}`;
}

function describeWhiteboardEvent(event: WhiteboardEvent): string {
  const parts: string[] = [];
  if (event.upserts?.length) {
    parts.push(`upserts ${event.upserts.map((element) => element.id).join(",")}`);
  }
  if (event.removedIds?.length) parts.push(`removes ${event.removedIds.join(",")}`);
  if (event.isOpen !== undefined) parts.push(event.isOpen ? "opens" : "closes");
  if (event.isMaximized !== undefined) {
    parts.push(event.isMaximized ? "maximizes" : "restores");
  }
  if (event.view) parts.push("moves the view");
  return parts.join(", ") || "no change";
}

/**
 * The recorder stamps each event itself, so the time the driver put on it
 * says nothing. Everything else must have come through unchanged.
 */
function sameEventApartFromTime<E extends { timestamp: number }>(left: E, right: E): boolean {
  return firstDifference({ ...left, timestamp: 0 }, { ...right, timestamp: 0 }, "event") === null;
}

/**
 * The recording holds exactly the events the driver sent, in the order sent,
 * and nothing else. A studio render has no person at the page, so an event
 * the driver did not send came from the page itself (the whiteboard's own
 * change report echoing the driver's scene back, say).
 */
function provenanceCheck<E extends { timestamp: number }>(
  id: string,
  recorded: readonly E[],
  sent: readonly E[],
  describe: (event: E) => string,
): Omit<StudioCheckResult, "advisory"> {
  const missing: number[] = [];
  const unsent: number[] = [];
  let next = 0;
  for (let index = 0; index < recorded.length; index++) {
    const event = recorded[index];
    if (next < sent.length && sameEventApartFromTime(event, sent[next])) {
      next++;
      continue;
    }
    let found = -1;
    const end = Math.min(sent.length, next + 1 + PROVENANCE_LOOKAHEAD);
    for (let candidate = next + 1; candidate < end; candidate++) {
      if (sameEventApartFromTime(event, sent[candidate])) {
        found = candidate;
        break;
      }
    }
    if (found === -1) {
      unsent.push(index);
      continue;
    }
    for (let skipped = next; skipped < found; skipped++) missing.push(skipped);
    next = found + 1;
  }
  for (; next < sent.length; next++) missing.push(next);

  if (missing.length === 0 && unsent.length === 0) {
    return {
      id,
      ok: true,
      detail: `${sent.length} events sent, all recorded once and in order`,
    };
  }
  const problems: string[] = [];
  if (missing.length > 0) {
    const first = missing[0];
    problems.push(
      `${missing.length} of ${sent.length} sent events missing or changed (first: sent #${first + 1}, ${describe(sent[first])})`,
    );
  }
  if (unsent.length > 0) {
    const first = recorded[unsent[0]];
    problems.push(
      `${unsent.length} recorded events the driver never sent (first at ${Math.round(first.timestamp)} ms: ${describe(first)})`,
    );
  }
  return { id, ok: false, detail: problems.join("; ") };
}

// ---------------------------------------------------------------------------
// Round trip: every track survives encoding
// ---------------------------------------------------------------------------

/**
 * Every track of the recording equals itself after the file is written and
 * read back. The comparison takes the encoder's own input: frames as the
 * encoder normalizes them (normalizeRecordingData), and only the slide events
 * the decoder keeps (isSlideEventKeptOnDecode).
 * An empty track and a missing one are the same.
 */
function roundTripCheck(
  recording: Recording,
  decoded: Recording | null,
): Omit<StudioCheckResult, "advisory"> {
  const id = "capture.tracks.roundTrip";
  if (!decoded) {
    return { id, ok: false, detail: "the artifact did not decode, so no track was compared" };
  }
  const encoded = normalizeRecordingData(recording);
  const differences: string[] = [];
  for (const track of RECORDING_TRACK_NAMES) {
    const before: readonly unknown[] =
      track === "slideEvents"
        ? (encoded.slideEvents ?? []).filter(isSlideEventKeptOnDecode)
        : (encoded[track] ?? []);
    const difference = firstDifference(before, decoded[track] ?? [], track);
    if (difference) differences.push(difference);
  }
  return differences.length === 0
    ? {
        id,
        ok: true,
        detail: `${RECORDING_TRACK_NAMES.length} tracks equal after encode and decode`,
      }
    : { id, ok: false, detail: `changed by encode and decode: ${listed(differences)}` };
}

// ---------------------------------------------------------------------------
// The recording's side: each track's state, from core's own resolvers
// ---------------------------------------------------------------------------

/** The editor text and selection after frame `index`, as replay folds it. */
function frameAt(recording: Recording, index: number) {
  return reconstructFrameAtIndex(recording.frames, index)?.state ?? null;
}

/**
 * The editor text replay shows at `timeMs` when no frame applies there: the
 * last frame by then belongs to a file the recording has since switched away
 * from (replay's own rule, latestEditorModelBoundaryTime), so the editor
 * shows the open file's text from the workspace track. Undefined when a
 * frame applies.
 */
function workspaceTextWithoutFrame(
  recording: Recording,
  timeMs: number,
): { path: string; text: string } | undefined {
  const events = recording.workspaceEvents ?? [];
  const workspaceIndex = findTimedEventIndexAtOrBefore(events, timeMs, -1);
  const boundary = latestEditorModelBoundaryTime(events, workspaceIndex);
  const frame = recording.frames[findTimedEventIndexAtOrBefore(recording.frames, timeMs, -1)];
  if (boundary === null || !frame || frame.timestamp >= boundary) return undefined;
  const { activeFilePath, project } = events[workspaceIndex].snapshot;
  const file = project.files[activeFilePath];
  return { path: activeFilePath, text: file && isWorkspaceTextFile(file) ? file.content : "" };
}

/** Why the workspace store's files differ from a recorded set, or null when they do not. */
function filesDifference(
  shown: Readonly<Record<string, WorkspaceFile>>,
  recorded: Readonly<Record<string, WorkspaceFile>>,
): string | null {
  const onlyShown = Object.keys(shown).filter((path) => !Object.hasOwn(recorded, path));
  if (onlyShown.length > 0) return `${onlyShown[0]} is not in the recording`;
  const onlyRecorded = Object.keys(recorded).filter((path) => !Object.hasOwn(shown, path));
  if (onlyRecorded.length > 0) return `${onlyRecorded[0]} is only in the recording`;
  for (const path of Object.keys(shown)) {
    const left = shown[path];
    const right = recorded[path];
    if (areWorkspaceFilesEqual(left, right)) continue;
    return isWorkspaceTextFile(left) && isWorkspaceTextFile(right) && left.content !== right.content
      ? `${path} parts at ${textPartsAt(left.content, right.content)}`
      : `${path} differs`;
  }
  return null;
}

function selectionDifference(
  editor: EditorReading,
  recorded: ReturnType<typeof frameAt>,
): string | null {
  if (!editor.selection || !recorded) return null;
  const shown = editor.selection;
  const selection = recorded.selection;
  const same =
    shown.selectionStartLineNumber === selection.selectionStartLineNumber &&
    shown.selectionStartColumn === selection.selectionStartColumn &&
    shown.positionLineNumber === selection.positionLineNumber &&
    shown.positionColumn === selection.positionColumn;
  return same
    ? null
    : `the selection is ${shown.selectionStartLineNumber}:${shown.selectionStartColumn}→${shown.positionLineNumber}:${shown.positionColumn}, the last frame has ${selection.selectionStartLineNumber}:${selection.selectionStartColumn}→${selection.positionLineNumber}:${selection.positionColumn}`;
}

/** What a viewer sees of the slide panel: nothing more than "closed" when it is shut. */
function visibleSlidePanel(state: SlidePreviewState): string {
  return state.isOpen
    ? `open on ${state.currentSlideId ?? "no slide"}${state.isMaximized ? ", maximized" : ""}, step ${state.indexv ?? 0}`
    : "closed";
}

// ---------------------------------------------------------------------------
// End of take: the page against the recording's last state, track by track
// ---------------------------------------------------------------------------

function endOfTakeChecks(
  recording: Recording,
  observations: CaptureObservations,
): Omit<StudioCheckResult, "advisory">[] {
  const page = observations.endOfTake;
  const ids = [
    "capture.end.editor",
    "capture.end.workspace",
    "capture.end.console",
    "capture.end.whiteboard",
    "capture.end.slides",
  ];
  if (!page) {
    return ids.map((id) => ({
      id,
      ok: false,
      detail: "the page was not read at the end of the take",
    }));
  }

  // Editor: Monaco's text and selection against the last frame, or against
  // the open file's recorded text when no frame of that file was recorded.
  const lastFrame = frameAt(recording, recording.frames.length - 1);
  const withoutFrame = workspaceTextWithoutFrame(recording, Number.POSITIVE_INFINITY);
  let editorProblem: string | null;
  if (!page.editor) {
    editorProblem = "no editor was on screen at the end of the take";
  } else if (withoutFrame) {
    editorProblem =
      page.editor.text === withoutFrame.text
        ? null
        : `no frame was recorded after the switch to ${withoutFrame.path}, and the editor and that file's recorded text part at ${textPartsAt(page.editor.text, withoutFrame.text)}`;
  } else if (!lastFrame) {
    editorProblem = "the recording has no frame";
  } else if (page.editor.text !== lastFrame.content) {
    editorProblem = `the editor${page.editor.path ? ` (${page.editor.path})` : ""} and the last frame part at ${textPartsAt(page.editor.text, lastFrame.content)}`;
  } else {
    editorProblem = selectionDifference(page.editor, lastFrame);
  }

  // Workspace: the store's files against the last workspace event.
  const lastWorkspace = recording.workspaceEvents?.at(-1);
  const workspaceProblem = lastWorkspace
    ? filesDifference(page.workspaceFiles, lastWorkspace.snapshot.project.files)
    : "the recording has no workspace event";

  // Console: the store's lines against the runtime track's last state. On the
  // real clock a running program may print after the read, so the recording
  // may hold more lines after the ones read, never other ones.
  const recordedLines = resolveLatestRuntimeSnapshot(recording.runtimeEvents)?.consoleLines ?? [];
  const shownLines = page.consoleLines;
  const linesMatch =
    observations.clock === "real"
      ? recordedLines.length >= shownLines.length &&
        shownLines.every((line, index) => line === recordedLines[index])
      : firstDifference(shownLines, recordedLines, "lines") === null;
  const lineDifference = linesMatch
    ? null
    : firstDifference(
        shownLines.slice(0, recordedLines.length),
        recordedLines.slice(0, shownLines.length),
        "line",
      );
  const consoleProblem = linesMatch
    ? null
    : `the console shows ${shownLines.length} lines, the recording ends on ${recordedLines.length}${lineDifference ? ` (${lineDifference})` : ""}`;

  // Whiteboard: the store's elements and panel flags against the scene replay ends on.
  const recordedBoard =
    getWhiteboardReplayResult({
      whiteboardEvents: recording.whiteboardEvents ?? [],
      currentTime: Number.POSITIVE_INFINITY,
      lastAppliedIndex: -1,
    }).stateToApply ?? EMPTY_WHITEBOARD_SCENE;
  const whiteboardProblem =
    firstDifference(page.whiteboard.elements, recordedBoard.elements, "elements") ??
    (page.whiteboard.isOpen !== recordedBoard.isOpen
      ? `the board is ${page.whiteboard.isOpen ? "open" : "closed"}, the recording ends ${recordedBoard.isOpen ? "open" : "closed"}`
      : page.whiteboard.isMaximized !== recordedBoard.isMaximized
        ? `the board is ${page.whiteboard.isMaximized ? "" : "not "}maximized, the recording ends ${recordedBoard.isMaximized ? "" : "not "}maximized`
        : null);

  // Slides: the store's panel against the deck state replay ends on.
  const recordedDeck = getSlideReplayResult({
    slideEvents: recording.slideEvents ?? [],
    slides: recording.slides,
    currentTime: Number.POSITIVE_INFINITY,
    lastAppliedIndex: -1,
    isResync: true,
  }).applications[0]?.slideState;
  const shownDeck = visibleSlidePanel(page.slidePanel);
  const endDeck = recordedDeck ? visibleSlidePanel(recordedDeck) : "closed";
  const slidesProblem =
    shownDeck === endDeck ? null : `the panel is ${shownDeck}, the recording ends ${endDeck}`;

  const lastFrameTime = recording.frames.at(-1)?.timestamp ?? 0;
  return [
    {
      id: ids[0],
      ok: editorProblem === null,
      detail:
        editorProblem ??
        (withoutFrame
          ? `no frame was recorded after the switch to ${withoutFrame.path}; the editor's text equals that file's recorded text`
          : `the editor's text and selection equal the last frame (${Math.round(lastFrameTime)} ms)`),
    },
    {
      id: ids[1],
      ok: workspaceProblem === null,
      detail:
        workspaceProblem ??
        `${Object.keys(page.workspaceFiles).length} files equal the last workspace event`,
    },
    {
      id: ids[2],
      ok: consoleProblem === null,
      detail: consoleProblem ?? `${shownLines.length} console lines equal the runtime track's end`,
    },
    {
      id: ids[3],
      ok: whiteboardProblem === null,
      detail:
        whiteboardProblem ??
        `${page.whiteboard.elements.length} elements and the panel equal the scene replay ends on`,
    },
    {
      id: ids[4],
      ok: slidesProblem === null,
      detail: slidesProblem ?? `the slide panel is ${shownDeck}, as the recording ends`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Per action: what each action left is recorded at its end
// ---------------------------------------------------------------------------

interface TimedTrackMatch {
  matched: boolean;
  lagMs: number;
}

/**
 * Whether the track reaches the state an action left by the window's end:
 * the state just before the action ended, or the state after any event
 * stamped from the end to `windowEndMs`, matches. The lag is how long after
 * the end the matching event came (0 when it was already there).
 */
function matchInWindow(
  events: readonly { timestamp: number }[],
  endedAtMs: number,
  windowEndMs: number,
  matches: (index: number) => boolean,
): TimedTrackMatch {
  let before = findTimedEventIndexAtOrBefore(events as { timestamp: number }[], endedAtMs, -1);
  while (before >= 0 && events[before].timestamp >= endedAtMs) before--;
  if (before >= 0 && matches(before)) return { matched: true, lagMs: 0 };
  for (
    let index = before + 1;
    index < events.length && events[index].timestamp <= windowEndMs;
    index++
  ) {
    if (matches(index)) {
      return { matched: true, lagMs: Math.max(0, events[index].timestamp - endedAtMs) };
    }
  }
  return { matched: false, lagMs: 0 };
}

/** The last state the track holds by the window's end, for saying how it differs. */
function lastIndexBy(events: readonly { timestamp: number }[], timeMs: number): number {
  return findTimedEventIndexAtOrBefore(events as { timestamp: number }[], timeMs, -1);
}

function actionEndChecks(
  recording: Recording,
  observations: CaptureObservations,
): Omit<StudioCheckResult, "advisory">[] {
  const windowMs = ACTION_END_WINDOW_MS[observations.clock];
  const starts = observations.receipts
    .filter((receipt) => receipt.startedAtMs !== null)
    .map((receipt) => ({ actionId: receipt.actionId, startedAtMs: receipt.startedAtMs as number }));
  // A runtime.start runs in the background, and while it installs and boots
  // the runtime writes to the page on its own schedule; nothing measured then
  // says anything about the action that ended.
  const runtimeStarts = observations.receipts
    .filter((receipt) => receipt.actionType === "runtime.start" && receipt.startedAtMs !== null)
    .map((receipt) => ({
      from: receipt.startedAtMs as number,
      to: receipt.endedAtMs ?? Number.POSITIVE_INFINITY,
    }));

  const workspaceEvents = recording.workspaceEvents ?? [];
  const frames = recording.frames;
  const workspaceMisses: string[] = [];
  const editorMisses: string[] = [];
  let compared = 0;
  let skipped = 0;
  let workspaceLagMs = 0;
  let editorLagMs = 0;

  for (const { actionId, endedAtMs, reading } of observations.actionEnds) {
    if (runtimeStarts.some(({ from, to }) => endedAtMs >= from && endedAtMs <= to)) {
      skipped++;
      continue;
    }
    compared++;
    const nextStart = Math.min(
      ...starts
        .filter((start) => start.actionId !== actionId && start.startedAtMs >= endedAtMs)
        .map((start) => start.startedAtMs),
    );
    const windowEndMs = Math.min(endedAtMs + windowMs, nextStart);
    const at = `${actionId} at ${Math.round(endedAtMs)} ms`;

    const workspace = matchInWindow(
      workspaceEvents,
      endedAtMs,
      windowEndMs,
      (index) =>
        filesDifference(reading.workspaceFiles, workspaceEvents[index].snapshot.project.files) ===
        null,
    );
    if (workspace.matched) {
      workspaceLagMs = Math.max(workspaceLagMs, workspace.lagMs);
    } else {
      const last = workspaceEvents[lastIndexBy(workspaceEvents, windowEndMs)];
      workspaceMisses.push(
        `${at}: ${last ? filesDifference(reading.workspaceFiles, last.snapshot.project.files) : "no workspace event yet"}`,
      );
    }

    const editor = reading.editor;
    if (!editor) {
      editorMisses.push(`${at}: no editor was on screen`);
      continue;
    }
    const frameText = matchInWindow(
      frames,
      endedAtMs,
      windowEndMs,
      (index) => frameAt(recording, index)?.content === editor.text,
    );
    // After a switch to a file no frame was recorded for yet, replay shows
    // that file's recorded text, so that is what must match.
    const text = frameText.matched
      ? frameText
      : matchInWindow(
          workspaceEvents,
          endedAtMs,
          windowEndMs,
          (index) =>
            workspaceTextWithoutFrame(recording, workspaceEvents[index].timestamp)?.text ===
            editor.text,
        );
    if (text.matched) {
      editorLagMs = Math.max(editorLagMs, text.lagMs);
    } else {
      const last = frameAt(recording, lastIndexBy(frames, windowEndMs));
      editorMisses.push(
        `${at}: ${last ? `the editor and the frame part at ${textPartsAt(editor.text, last.content)}` : "no frame yet"}`,
      );
    }
  }

  const scope = `${compared} actions${skipped > 0 ? ` (${skipped} skipped while the runtime started)` : ""}, window ${windowMs} ms`;
  return [
    {
      id: "capture.actions.workspace",
      ok: workspaceMisses.length === 0,
      detail:
        workspaceMisses.length === 0
          ? `${scope}: each action's files recorded, largest lag ${Math.round(workspaceLagMs)} ms`
          : `${scope}: ${workspaceMisses.length} actions left files the recording does not hold by the window's end: ${listed(workspaceMisses)}; largest lag ${Math.round(workspaceLagMs)} ms`,
    },
    {
      id: "capture.actions.editor",
      ok: editorMisses.length === 0,
      detail:
        editorMisses.length === 0
          ? `${scope}: each action's editor text recorded, largest lag ${Math.round(editorLagMs)} ms`
          : `${scope}: ${editorMisses.length} actions left editor text no frame holds by the window's end: ${listed(editorMisses)}; largest lag ${Math.round(editorLagMs)} ms`,
    },
  ];
}
