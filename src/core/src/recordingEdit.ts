import type { CaptionCue, CaptionTrack, CursorRecordingEvent, Recording } from "./types";
import type { PreviewDomPatchBatch, PreviewInitialDocument } from "./preview";
import { createKeyframe, reconstructFrameAtIndex } from "./utils/frameDelta";
import type { DeltaFrame } from "./utils/deltaTypes";
import { buildRecordingClusters } from "./utils/recordingClusters";
import {
  mapRecordingTimeToMediaTime,
  normalizeMediaSpans,
  type MediaSpan,
} from "./utils/mediaSpans";
import { hasAudioEdit, type AudioEdit } from "./utils/audioEdit";
import { captionTextFromWords } from "./utils/captionCues";
import { getRrwebReplayLead } from "./utils/previewReplayLead";

// ============================================================================
// Cutting and muting a finished recording.
//
// A recording's tracks are logs of changes, so a cut cannot simply delete what
// falls inside it: the code typed during a cut span is still in the file after
// it. Instead a cut span is collapsed into CUT_WINDOW_MS at its start. Every
// change inside it is kept, in order, and applied in that one instant, and
// everything after it moves earlier. The editor frames inside a cut are then
// squashed into one keyframe of their final state, so text typed and deleted
// within the cut leaves no trace in the file. The narration is cut for real (a
// pending audio edit, applied when the recording loads), and the camera is
// mapped around the cut the way it is around a retake's.
// ============================================================================

/**
 * How long a cut span lasts after the edit. Long enough that the changes inside it
 * keep a strict order on every track (rrweb replays by timestamp alone), short
 * enough never to be seen or heard.
 */
export const CUT_WINDOW_MS = 1;

export interface RecordingEdit {
  /** Spans to remove from the recording, in its current time (ms). */
  cuts: readonly MediaSpan[];
  /** Spans whose narration is silenced, in the same time. */
  mutes: readonly MediaSpan[];
}

/**
 * Where a moment of the recording lands once `cuts` (normalized) are collapsed.
 * Monotonic, so every track keeps its order.
 */
export function mapTimeThroughCuts(time: number, cuts: readonly MediaSpan[]): number {
  let removed = 0;
  for (const cut of cuts) {
    if (time <= cut.start) break;
    const length = cut.end - cut.start;
    const window = Math.min(CUT_WINDOW_MS, length);
    if (time < cut.end) {
      return cut.start - removed + ((time - cut.start) / length) * window;
    }
    removed += length - window;
  }
  return time - removed;
}

const isInsideCut = (time: number, cuts: readonly MediaSpan[]) =>
  cuts.some((cut) => time > cut.start && time <= cut.end);

/** The cut a moment falls inside, as an index, or -1. */
const cutIndexOf = (time: number, cuts: readonly MediaSpan[]) =>
  cuts.findIndex((cut) => time > cut.start && time <= cut.end);

function editFrames(frames: readonly DeltaFrame[], cuts: readonly MediaSpan[]): DeltaFrame[] {
  const edited: DeltaFrame[] = [];
  frames.forEach((frame, index) => {
    const cut = cutIndexOf(frame.timestamp, cuts);
    if (cut < 0) {
      edited.push({ ...frame, timestamp: mapTimeThroughCuts(frame.timestamp, cuts) });
      return;
    }

    // The frames of a cut are squashed into one keyframe of the state at its last one.
    const next = frames[index + 1];
    if (next && cutIndexOf(next.timestamp, cuts) === cut) return;
    const state = reconstructFrameAtIndex(frames, index);
    if (state) {
      edited.push(
        createKeyframe({ ...state, timestamp: mapTimeThroughCuts(state.timestamp, cuts) }),
      );
    }
  });
  return edited;
}

function editCursorEvents(
  events: readonly CursorRecordingEvent[],
  cuts: readonly MediaSpan[],
): CursorRecordingEvent[] {
  // The pointer is only a position: inside a cut, where it ended up is all that counts.
  return events
    .filter((event, index) => {
      if (!isInsideCut(event.timestamp, cuts)) return true;
      const next = events[index + 1];
      return !next || cutIndexOf(next.timestamp, cuts) !== cutIndexOf(event.timestamp, cuts);
    })
    .map((event) => ({ ...event, timestamp: mapTimeThroughCuts(event.timestamp, cuts) }));
}

const retimeByTimestamp = <T extends { timestamp: number }>(
  events: readonly T[] | undefined,
  cuts: readonly MediaSpan[],
): T[] | undefined =>
  events?.map((event) => ({ ...event, timestamp: mapTimeThroughCuts(event.timestamp, cuts) }));

/**
 * rrweb events are placed by their own stamps less one offset (getRrwebReplayLead, which
 * replay rebases by too). Rebasing every stamp onto recorded time first lets the cuts
 * apply to it directly; each segment's `time` is kept at or after its first event, which
 * makes that offset 0.
 */
function editPreviewSegments(
  initialDocuments: readonly PreviewInitialDocument[] | undefined,
  patchBatches: readonly PreviewDomPatchBatch[] | undefined,
  cuts: readonly MediaSpan[],
): { initialDocuments?: PreviewInitialDocument[]; patchBatches?: PreviewDomPatchBatch[] } {
  const lead = getRrwebReplayLead(initialDocuments ?? [], patchBatches ?? []);

  const retime = <T extends PreviewInitialDocument | PreviewDomPatchBatch>(segment: T): T => {
    const time = mapTimeThroughCuts(segment.time, cuts);
    if (!segment.events?.length || lead === -Infinity) return { ...segment, time };
    const events = segment.events.map((event) => ({
      ...event,
      timestamp: mapTimeThroughCuts(event.timestamp - lead, cuts),
    }));
    return { ...segment, time: Math.max(time, events[0].timestamp), events };
  };

  return {
    initialDocuments: initialDocuments?.map(retime),
    patchBatches: patchBatches?.map(retime),
  };
}

function editCaptionCues(cues: readonly CaptionCue[], cuts: readonly MediaSpan[]): CaptionCue[] {
  const edited: CaptionCue[] = [];
  for (const cue of cues) {
    const start = mapTimeThroughCuts(cue.start, cuts);
    const end = mapTimeThroughCuts(cue.end, cuts);
    // A cue said entirely inside a cut went with it.
    if (end - start < CUT_WINDOW_MS * 2) continue;
    if (!cue.words) {
      edited.push({ ...cue, start, end });
      continue;
    }

    // A word was cut when it had length and lost it: one too short to measure stays.
    const words = cue.words.flatMap((word) => {
      const mapped = {
        ...word,
        start: mapTimeThroughCuts(word.start, cuts),
        end: mapTimeThroughCuts(word.end, cuts),
      };
      const wasCut =
        word.end - word.start >= CUT_WINDOW_MS * 2 && mapped.end - mapped.start < CUT_WINDOW_MS * 2;
      return wasCut ? [] : [mapped];
    });
    if (words.length === cue.words.length) {
      // Nothing said was cut, so the cue reads as it was written.
      edited.push({ ...cue, start, end, words });
    } else if (words.length > 0) {
      // Its text loses the words cut from the narration.
      edited.push({ ...cue, start, end, words, text: captionTextFromWords(words) });
    }
  }
  return edited;
}

function editCaptions(
  tracks: readonly CaptionTrack[] | undefined,
  cuts: readonly MediaSpan[],
): CaptionTrack[] | undefined {
  return tracks?.map((track) => ({ ...track, cues: editCaptionCues(track.cues, cuts) }));
}

/** Moves recorded-time spans onto an audio file whose time 0 is `offsetMs` into the recording. */
const toAudioTime = (spans: readonly MediaSpan[], offsetMs: number) =>
  normalizeMediaSpans(
    spans.map((span) => ({ start: span.start - offsetMs, end: span.end - offsetMs })),
  );

/**
 * The recording with `edit` applied: cut spans collapsed on every track, muted spans
 * silenced, the narration edit left for loading to apply, and the camera mapped
 * around the cuts. Does not change the recording given; returns a new one with a
 * fresh id.
 */
export function applyRecordingEdit(recording: Recording, edit: RecordingEdit): Recording {
  const hasAudio = recording.audioBlob instanceof Blob;
  // Narration that is only a URL would stay uncut and drift from everything after the
  // first cut, so the caller fetches it first.
  if (!hasAudio && (recording.audioUrl || recording.audioFile)) {
    throw new Error("The recording's narration must be loaded before it can be edited");
  }
  // A pending narration edit (a retake's) is on the narration's own clock, and this
  // edit's would replace it.
  if (hasAudioEdit(recording.pendingAudioEdit)) {
    throw new Error("The recording's narration is still being cut; edit it once that is done");
  }

  const validCuts = normalizeMediaSpans(
    edit.cuts.map((cut) => ({ start: cut.start, end: Math.min(cut.end, recording.duration) })),
  );
  const mutes = normalizeMediaSpans(edit.mutes);
  const duration = Math.max(1, mapTimeThroughCuts(recording.duration, validCuts));
  const preview = editPreviewSegments(
    recording.previewInitialDocuments,
    recording.previewPatchBatches,
    validCuts,
  );
  const frames = editFrames(recording.frames, validCuts);

  // The narration loses each cut span but its last CUT_WINDOW_MS, which is what the
  // timeline keeps of it, so the two stay in step past every cut.
  const audioOffset = recording.audioStartOffsetMs ?? 0;
  const audioCuts = validCuts.map((cut) => ({
    start: cut.start,
    end: cut.end - Math.min(CUT_WINDOW_MS, cut.end - cut.start),
  }));
  const audioEdit: AudioEdit | undefined =
    hasAudio && (audioCuts.length > 0 || mutes.length > 0)
      ? { cuts: toAudioTime(audioCuts, audioOffset), mutes: toAudioTime(mutes, audioOffset) }
      : undefined;

  // The camera's own cuts are on its media timeline, which retakes' cuts already skip
  // around; this edit's cuts are moved onto it first.
  const priorCameraCuts = recording.cameraCuts ?? [];
  const cameraCuts = normalizeMediaSpans([
    ...priorCameraCuts,
    ...audioCuts.map((cut) => ({
      start: mapRecordingTimeToMediaTime(cut.start, priorCameraCuts),
      end: mapRecordingTimeToMediaTime(cut.end, priorCameraCuts),
    })),
  ]);
  const hasCamera = Boolean(recording.cameraBlob || recording.cameraUrl || recording.cameraFile);

  return {
    ...recording,
    id: Date.now().toString(),
    frames,
    slideEvents: retimeByTimestamp(recording.slideEvents, validCuts),
    previewEvents: retimeByTimestamp(recording.previewEvents, validCuts),
    previewInitialDocuments: preview.initialDocuments,
    previewPatchBatches: preview.patchBatches,
    workspaceEvents: retimeByTimestamp(recording.workspaceEvents, validCuts),
    runtimeEvents: retimeByTimestamp(recording.runtimeEvents, validCuts),
    cursorEvents: recording.cursorEvents
      ? editCursorEvents(recording.cursorEvents, validCuts)
      : undefined,
    whiteboardEvents: retimeByTimestamp(recording.whiteboardEvents, validCuts),
    chatEvents: retimeByTimestamp(recording.chatEvents, validCuts),
    captions: editCaptions(recording.captions, validCuts),
    // A chapter inside a cut starts where the cut now is.
    chapters: recording.chapters?.map((chapter) => ({
      ...chapter,
      time: mapTimeThroughCuts(chapter.time, validCuts),
    })),
    duration,
    clusters: frames.length > 0 ? buildRecordingClusters(frames, duration) : undefined,
    tracks: recording.tracks?.map((track) => ({ ...track, durationMs: duration })),
    pendingAudioEdit: audioEdit,
    // The edited narration is a new file: it is named from its own type when saved.
    ...(audioEdit ? { audioFile: undefined, audioUrl: undefined } : {}),
    cameraCuts: hasCamera && cameraCuts.length > 0 ? cameraCuts : undefined,
  };
}
