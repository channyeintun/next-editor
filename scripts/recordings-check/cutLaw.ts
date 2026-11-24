/**
 * A cut keeps what is outside it, on a real recording.
 *
 * Each of K seeded cuts is applied on its own. For a time t outside the cut, the
 * edited recording seeked to where t moves must show what the original seeked to t
 * shows, per track as the law states it (src/core/src/recordingEditLaw.test.ts):
 *
 *   * editor: the frame applied (text, selection, view state), or none and then the
 *     open file's text;
 *   * workspace: the open project and file, every file but the open one, and the
 *     panel widths. The cut writes the editor's text at its end into the open file;
 *   * runtime, chat, slides and the preview panel: exactly, the time of the preview's
 *     last refresh moved with the cut;
 *   * whiteboard: exactly, away from a cut's edges, where replay animates toward the
 *     next event and a cut moves that event.
 *
 * The pointer and captions are outside the law and are counted in rows of their own:
 * the pointer glides over the gap to its next sample, which a cut shortens, and a
 * caption said across a cut loses the words that were cut.
 */

import type { Recording } from "../../src/core/src";
import { applyRecordingEdit, mapTimeThroughCuts } from "../../src/core/src/recordingEdit";
import type { PreviewState } from "../../src/core/src/preview";
import type { CaptionTrack } from "../../src/core/src/types";
import {
  getCursorPositionAtTime,
  getCursorReplaySamples,
} from "../../src/core/src/utils/cursorReplay";
import { normalizeMediaSpans, type MediaSpan } from "../../src/core/src/utils/mediaSpans";
import {
  countOdd,
  createCheck,
  tallyOf,
  untilStopped,
  type CheckResult,
  type LawScope,
} from "./check.ts";
import { openReplayPage, PAGE_TRACKS, type PageShown } from "./page.ts";
import { seededRandom } from "./random.ts";
import { compare, roundedMs } from "./tally.ts";
import { replayedStamps } from "./times.ts";

export const CUT_LAW = "cut law";

/**
 * Comfortably more than replay's whiteboard animation window (private to
 * replayState/whiteboard.ts), as the generated law test uses: a wider margin only
 * compares less.
 */
export const WHITEBOARD_MARGIN_MS = 1_000;

/** The longest cut, as a share of the recording. */
const LONGEST_CUT_SHARE = 0.2;

/** Nudges for a cut edge placed on a recorded stamp: just before, on and just after. */
const EDGE_NUDGES = [-1, -0.5, 0, 0.5, 1, 40];

/** How far before a file switch a cut across switches starts, in ms. */
const LEAD_INS = [1, 40, 500, 5_000];

export type RecordingEditor = typeof applyRecordingEdit;

export interface CutLawOptions {
  cuts: number;
  seed: number;
  /** The grid of check times outside each cut, in ms. */
  everyMs: number;
  /** The cut under check; the real one unless a test hands in a broken one. */
  edit?: RecordingEditor;
}

export const DEFAULT_CUT_LAW: Pick<CutLawOptions, "cuts" | "everyMs"> = {
  cuts: 10,
  everyMs: 500,
};

const CUT_TRACKS: ReadonlyArray<{ track: string; scope: LawScope }> = [
  ...PAGE_TRACKS.map((track) => ({ track, scope: "in law" as const })),
  { track: "pointer", scope: "outside" },
  { track: "captions", scope: "outside" },
];

/**
 * K cuts, one per edit. Half the edges land on a recorded stamp, nudged, since cuts
 * that start or end where a track changes are where a squash goes wrong; the rest
 * land anywhere. Every third cut, when the recording has file switches, runs from
 * just before one switch to around a later one.
 */
export function pickCuts(recording: Recording, count: number, seed: number): MediaSpan[][] {
  const random = seededRandom(seed);
  const stamps = replayedStamps(recording);
  // File switches are few among thousands of frames, and a cut across one is where
  // replay can give a frame to the wrong file, so half the placed edges go on one.
  const switches = (recording.workspaceEvents ?? []).map((event) => event.timestamp);
  const duration = recording.duration;
  const pick = (from: readonly number[]) => from[Math.floor(random() * from.length)];
  const edge = (anywhere: number) => {
    if (stamps.length === 0 || random() < 0.5) return anywhere;
    const stamp = switches.length > 0 && random() < 0.5 ? pick(switches) : pick(stamps);
    return stamp + pick(EDGE_NUDGES);
  };
  // A cut from just before one file switch to around a later one: it spans a switch
  // away and back, or ends between a switch and the frame after it.
  const acrossSwitches = (): MediaSpan => {
    const from = Math.floor(random() * (switches.length - 1));
    const to = from + 1 + Math.floor(random() * Math.min(3, switches.length - 1 - from));
    const start = Math.max(0, switches[from] - pick(LEAD_INS));
    return { start, end: Math.min(duration, switches[to] + pick(EDGE_NUDGES)) };
  };
  const picked: MediaSpan[][] = [];
  for (let index = 0; index < count; index++) {
    if (switches.length >= 2 && index % 3 === 2) {
      const cut = acrossSwitches();
      picked.push(normalizeMediaSpans([{ ...cut, end: Math.max(cut.end, cut.start + 1) }]));
      continue;
    }
    // Whole milliseconds where an edge lands anywhere, so a cut reads back easily.
    const start = Math.max(0, edge(Math.round(random() * duration)));
    const length = Math.round(random() * duration * LONGEST_CUT_SHARE);
    const end = Math.min(duration, edge(start + length));
    picked.push(normalizeMediaSpans([{ start, end: Math.max(end, start + 1) }]));
  }
  return picked;
}

/** The times outside `cuts` to compare at: a grid, and just after and before each edge. */
function lawTimes(duration: number, cuts: readonly MediaSpan[], everyMs: number): number[] {
  const inside = (time: number) => cuts.some((cut) => time > cut.start && time <= cut.end);
  const times = new Set<number>();
  for (let time = 0; time <= duration; time += everyMs) times.add(time);
  for (const cut of cuts) {
    for (const time of [cut.start - 1, cut.start]) times.add(time);
    for (const after of [0.5, 1, 50, 300, 1_000]) times.add(cut.end + after);
  }
  return [...times]
    .filter((time) => time >= 0 && time <= duration && !inside(time))
    .sort((left, right) => left - right);
}

const nearAnEdge = (time: number, cuts: readonly MediaSpan[]) =>
  cuts.some(
    (cut) =>
      (time <= cut.start && cut.start - time < WHITEBOARD_MARGIN_MS) ||
      (time > cut.end && time - cut.end < WHITEBOARD_MARGIN_MS),
  );

/** The page as the law compares it: the open file's text is left to the editor. */
function underTheLaw(shown: PageShown, moveTime: (time: number) => number): PageShown {
  const workspace = shown.workspace as {
    activeFilePath?: string;
    files?: Record<string, string> | null;
  };
  const otherFiles =
    workspace.files &&
    Object.fromEntries(
      Object.entries(workspace.files).filter(([path]) => path !== workspace.activeFilePath),
    );
  // The preview's refresh key is the time of its last refresh, which the panel only
  // compares with the one before; a cut moves that time like every other.
  const preview = shown.preview as PreviewState | undefined;
  const refreshKey = preview?.refreshKey;
  return {
    ...shown,
    workspace: { ...workspace, files: otherFiles },
    preview: refreshKey === undefined ? preview : { ...preview, refreshKey: moveTime(refreshKey) },
  };
}

/** The text of every caption cue showing at `time`, per caption track. */
function captionsAt(captions: readonly CaptionTrack[] | undefined, time: number) {
  return (captions ?? []).map((track) =>
    track.cues.filter((cue) => cue.start <= time && time < cue.end).map((cue) => cue.text),
  );
}

function pointerAt(samples: ReturnType<typeof getCursorReplaySamples>, time: number) {
  const cursor = getCursorPositionAtTime(samples, time)?.cursor;
  return cursor && { x: cursor.x, y: cursor.y, visible: cursor.visible };
}

/** The narration is not checked here, and an edit refuses one it has not loaded. */
function withoutNarration(recording: Recording): Recording {
  const { audioUrl: _url, audioFile: _file, audioBlob: _blob, ...rest } = recording;
  return rest;
}

export function checkCutLaw(recording: Recording, options: CutLawOptions): CheckResult {
  const result = createCheck(CUT_LAW, CUT_TRACKS);
  const edit = options.edit ?? applyRecordingEdit;
  return untilStopped(result, () => {
    const original = withoutNarration(recording);
    const beforePointer = getCursorReplaySamples(original);
    const hasPointer = beforePointer.length > 0;
    const hasCaptions = (original.captions ?? []).some((track) => track.cues.length > 0);

    for (const cuts of pickCuts(original, options.cuts, options.seed)) {
      const edited = edit(original, { cuts, mutes: [] });
      // Both pages are new and seek the same times in the same order. A panel keeps
      // what it showed when a seek lands before its first event, so pages with
      // different pasts would differ for a reason that is not the cut.
      const before = openReplayPage(original);
      const after = openReplayPage(edited);
      countOdd(result, before.errors);
      const afterPointer = getCursorReplaySamples(edited);
      countOdd(result, after.errors);

      const note = `cut ${cuts.map((cut) => `${roundedMs(cut.start)}-${roundedMs(cut.end)}`).join(",")}`;
      for (const time of lawTimes(original.duration, cuts, options.everyMs)) {
        const moved = mapTimeThroughCuts(time, cuts);
        before.send({ type: "SEEK", time });
        after.send({ type: "SEEK", time: moved });
        countOdd(result, before.errors);
        countOdd(result, after.errors);
        const was = underTheLaw(before.shown(), (at) => mapTimeThroughCuts(at, cuts));
        const is = underTheLaw(after.shown(), (at) => at);
        for (const track of PAGE_TRACKS) {
          if (track === "whiteboard" && nearAnEdge(time, cuts)) continue;
          compare(tallyOf(result, track), time, was[track], is[track], note);
        }
        if (hasPointer) {
          const pointerWas = pointerAt(beforePointer, time);
          compare(
            tallyOf(result, "pointer"),
            time,
            pointerWas,
            pointerAt(afterPointer, moved),
            note,
          );
        }
        if (hasCaptions) {
          const captionsWere = captionsAt(original.captions, time);
          compare(
            tallyOf(result, "captions"),
            time,
            captionsWere,
            captionsAt(edited.captions, moved),
            note,
          );
        }
      }
    }
  });
}
