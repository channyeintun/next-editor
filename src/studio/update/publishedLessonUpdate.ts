import axios from "axios";
import type { QueryClient } from "@tanstack/react-query";
import type { OwnedLesson } from "@next-editor/infra";
import { fetchMyLessons } from "../../../infra/client/library/myLessonsApi";
import { invalidateLessonDerivedQueries } from "../../../infra/client/library/useMyLessons";
import {
  LessonReplaceError,
  replaceLessonMedia,
} from "../../../infra/client/upload/replaceLessonMedia";
import type { CaptionCue, Recording } from "../../core/src";
import { decompressBinaryToRecording } from "../../storage/recordingCodecClient";
import type { StudioRunArtifacts } from "../runStudioRender";
import type {
  StudioAutomationLessonChange,
  StudioAutomationLessonMatch,
  StudioAutomationReplacement,
} from "../studioWindowHandle";
import { lessonNeUrl } from "../tts/lessonVoiceClip";
import { describeWorkflowError } from "../workflow/workflowRunner";

/**
 * Putting a new render of a corrected lesson script in place of the lesson it
 * was published as: finding that lesson among the signed-in author's own,
 * saying what the new render changes, and replacing the lesson's recording
 * while its id, URL, thumbnail, playlist position and publish date stay.
 *
 * The new recording keeps the published recording's id, because learners'
 * saved workspace versions are keyed by it; nothing else is taken from the
 * old recording.
 */

/** How many changed cues a comparison quotes. */
const MAX_EXAMPLES = 5;
/** How much of a cue an example quotes. */
const EXAMPLE_TEXT_LIMIT = 60;
/** Cue times are sums of floating-point offsets; a smaller move is the same time. */
const CUE_TIME_TOLERANCE_MS = 0.5;

const NOT_SIGNED_IN =
  "You are not signed in on this site. Sign in with the account that owns the lesson, then try again.";

type OwnLessons = { lessons: OwnedLesson[] } | { refused: string };

async function ownLessons(): Promise<OwnLessons> {
  try {
    return { lessons: await fetchMyLessons() };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      return { refused: NOT_SIGNED_IN };
    }
    return { refused: `Could not list your lessons: ${describeWorkflowError(error)}` };
  }
}

function describeLesson(lesson: OwnedLesson): string {
  return `"${lesson.title}" (${lesson.slug}, ${lesson.status})`;
}

/**
 * The signed-in author's lesson a script was published as: the one whose URL
 * slug is `lesson` when given, else the one titled `title`. None or several is
 * a refusal that names what it found, so a person can pick one by its slug.
 */
export async function findPublishedLesson(input: {
  title: string;
  lesson?: string;
}): Promise<StudioAutomationLessonMatch> {
  const listed = await ownLessons();
  if ("refused" in listed) return listed;
  const { lessons } = listed;

  const wanted = input.lesson?.trim();
  if (wanted) {
    const named = lessons.find((lesson) => lesson.slug === wanted);
    if (!named) {
      return { refused: `None of your ${lessons.length} lessons has the URL slug "${wanted}".` };
    }
    return foundOf(named);
  }

  const title = input.title.trim();
  const matches = lessons.filter((lesson) => lesson.title.trim() === title);
  if (matches.length === 1) return foundOf(matches[0]);
  if (matches.length === 0) {
    return {
      refused: `None of your ${lessons.length} lessons is titled "${title}". Name the lesson by its URL slug instead.`,
    };
  }
  return {
    refused: `${matches.length} of your lessons are titled "${title}": ${matches
      .map(describeLesson)
      .join(", ")}. Name the one to replace by its URL slug.`,
  };
}

function foundOf(lesson: OwnedLesson): StudioAutomationLessonMatch {
  return {
    found: {
      lessonId: lesson.id,
      urlSlug: lesson.slug,
      title: lesson.title,
      status: lesson.status,
      duration: lesson.duration ?? "",
    },
  };
}

/** The cues a recording shows by default: its default caption track, else its first. */
function cuesOf(recording: Recording): CaptionCue[] {
  const tracks = recording.captions ?? [];
  return (tracks.find((track) => track.default) ?? tracks[0])?.cues ?? [];
}

function cueText(cue: CaptionCue): string {
  return cue.text.replace(/\s+/g, " ").trim();
}

function quote(cue: CaptionCue | undefined): string {
  if (!cue) return "(no cue)";
  const text = cueText(cue);
  return `"${text.length > EXAMPLE_TEXT_LIMIT ? `${text.slice(0, EXAMPLE_TEXT_LIMIT - 1)}…` : text}"`;
}

/** A cue time as m:ss.s, close enough for a person to see a cue move. */
function cueTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= CUE_TIME_TOLERANCE_MS;
}

/**
 * What the new recording changes in the published one's captions, cue by cue
 * in order (two scenes may say the same sentence, so cues are matched by
 * position, not by text). A cue differs when its words differ or it moved.
 * Examples quote changed words first, then moved cues.
 */
export function compareCaptions(
  published: Recording,
  next: Recording,
): Pick<StudioAutomationLessonChange, "changedCues" | "totalCues" | "examples"> {
  const before = cuesOf(published);
  const after = cuesOf(next);
  const totalCues = Math.max(before.length, after.length);
  const reworded: string[] = [];
  const moved: string[] = [];
  let changedCues = 0;
  for (let index = 0; index < totalCues; index += 1) {
    const old = before[index];
    const now = after[index];
    if (!old || !now || cueText(old) !== cueText(now)) {
      changedCues += 1;
      reworded.push(`${quote(old)} → ${quote(now)}`);
    } else if (!sameTime(old.start, now.start) || !sameTime(old.end, now.end)) {
      changedCues += 1;
      moved.push(`${quote(now)}: ${cueTime(old.start)} → ${cueTime(now.start)}`);
    }
  }
  return {
    changedCues,
    totalCues,
    examples: [...reworded, ...moved].slice(0, MAX_EXAMPLES),
  };
}

async function loadPublishedRecording(neUrl: string): Promise<Recording> {
  // Always the bytes viewers get now, not a copy this browser kept.
  const response = await fetch(neUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${neUrl} answered HTTP ${response.status}`);
  }
  return decompressBinaryToRecording(new Uint8Array(await response.arrayBuffer()));
}

function describeReplaceFailure(error: unknown): string {
  if (error instanceof LessonReplaceError) {
    const reason = error.cause ? `: ${describeWorkflowError(error.cause)}` : "";
    const done =
      error.done.length > 0
        ? ` Already done: ${error.done.join("; ")}.`
        : " Nothing on the lesson was changed.";
    return `${error.message}${reason}.${done}`;
  }
  return `${describeWorkflowError(error)}. Nothing on the lesson was changed.`;
}

/**
 * Compare the lesson `lessonId` with the run and, when `replace` is true, put
 * the run in its place. Refuses, saying why, when the lesson is not the
 * author's or its recording cannot be read; a replacement that stops part-way
 * says what it had already done.
 */
export async function replacePublishedLesson(input: {
  lessonId: string;
  run: { title: string; artifacts: StudioRunArtifacts };
  replace: boolean;
  onProgress?: (fraction: number | null) => void;
  /** Told that the lesson's data changed, so lists that show it refetch. */
  queryClient?: QueryClient;
}): Promise<StudioAutomationReplacement> {
  input.onProgress?.(null);
  const listed = await ownLessons();
  if ("refused" in listed) return listed;
  const lesson = listed.lessons.find((candidate) => candidate.id === input.lessonId);
  if (!lesson) {
    return { refused: `None of your lessons has the id ${input.lessonId}.` };
  }

  // A replacement writes `<id>.ne`; a lesson whose row names another file
  // would go on playing that one.
  const neUrl = lessonNeUrl(lesson.ne, globalThis.location?.origin ?? "");
  if (!neUrl || !lesson.ne.endsWith(`/${lesson.id}.ne`)) {
    return {
      refused: `${describeLesson(lesson)} does not keep its recording at ${lesson.id}.ne, so it cannot be replaced in place.`,
    };
  }

  let published: Recording;
  try {
    published = await loadPublishedRecording(neUrl);
  } catch (error) {
    return {
      refused: `Could not read the recording of ${describeLesson(lesson)}: ${describeWorkflowError(error)}`,
    };
  }

  const next = input.run.artifacts.recording;
  const change: StudioAutomationLessonChange = {
    lessonId: lesson.id,
    urlSlug: lesson.slug,
    ...compareCaptions(published, next),
    publishedDurationMs: published.duration,
    newDurationMs: next.duration,
  };
  if (!input.replace) return { compared: change };

  const lessonChanged = () => {
    if (input.queryClient) void invalidateLessonDerivedQueries(input.queryClient);
  };
  try {
    const replaced = await replaceLessonMedia({
      lessonId: lesson.id,
      recording: { ...next, id: published.id },
      previousAudioFile: published.audioFile ?? null,
      onProgress: input.onProgress,
    });
    lessonChanged();
    return {
      replaced: {
        ...change,
        audioFile: replaced.audioFile,
        removedAudioFile: replaced.removedAudioFile,
      },
    };
  } catch (error) {
    if (error instanceof LessonReplaceError && error.done.length > 0) lessonChanged();
    return {
      refused: `Replacing ${describeLesson(lesson)} with the new render of "${input.run.title}" stopped. ${describeReplaceFailure(error)}`,
    };
  }
}
