import type { Recording } from "@app/core/src";
import { buildRecordingFiles } from "@app/storage/recordingExport";
import { withNarrationInMemory } from "@app/storage/recordingSiblingMedia";
import { sha256Hex } from "@app/shared/sha256Hex";
import { formatMediaBytes, MAX_MEDIA_BYTES } from "../../lessons/uploadLimits";
import { updateLessonDuration } from "../library/myLessonsApi";
import { formatDuration, UploadLimitError } from "./uploadLesson";
import { uploadFile, type UploadTarget } from "./uploadFile";

/**
 * Putting a new recording in place of an existing lesson's, keeping the lesson
 * row (id, slug, URL, thumbnail, playlist position, publish date) as it is.
 *
 * The order is what keeps the lesson playable at every moment. The `.ne` is
 * served at one fixed name, so it is the switch: the narration goes up first
 * under a name taken from its own bytes, then the `.ne` that names it, so a
 * viewer gets either the old pair or the new pair, never the new `.ne` with
 * the old narration. Only then does the gallery's duration change.
 *
 * The narration the lesson named before stays where it is: a viewer who opened
 * the lesson before the change is still streaming that file by its name, and
 * would lose the narration mid-lesson if it went away. Deleting the lesson
 * clears its whole folder, old narrations included.
 */

export interface ReplaceLessonMediaInput {
  lessonId: string;
  /** The new recording, carrying the id it should keep and its narration. */
  recording: Recording;
  /** The narration file the lesson's current `.ne` names; null when it names none. */
  previousAudioFile: string | null;
  /** The bytes of the lesson's current `.ne`, to see whether the new one is the same. */
  publishedNe: Uint8Array | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export type ReplacedLessonMedia =
  /** The new `.ne` is byte for byte the published one, naming the same narration: nothing was written. */
  | { outcome: "unchanged"; audioFile: string }
  | {
      outcome: "replaced";
      /** The narration file the lesson's `.ne` names now. */
      audioFile: string;
      /** The narration file it named before, when that is another file; it is left in place. */
      previousAudioFile: string | null;
      /** The duration the lesson row shows now, as formatDuration writes it. */
      duration: string;
    };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * A replacement that stopped part-way. `done` lists, in plain words, what had
 * already been changed, so the person knows what state the lesson is in.
 */
export class LessonReplaceError extends Error {
  readonly done: readonly string[];

  constructor(message: string, done: readonly string[], cause: unknown) {
    super(message, { cause });
    this.name = "LessonReplaceError";
    this.done = done;
  }
}

/** `<lessonId>-<first 8 hex of the SHA-256 of the narration>`: a new name whenever the narration changes. */
export async function contentAddressedAudioBase(lessonId: string, audio: Blob): Promise<string> {
  const digest = await sha256Hex(new Uint8Array(await audio.arrayBuffer()));
  return `${lessonId}-${digest.slice(0, 8)}`;
}

export async function replaceLessonMedia(
  input: ReplaceLessonMediaInput,
): Promise<ReplacedLessonMedia> {
  const { lessonId, signal } = input;
  const recording = await withNarrationInMemory(input.recording);
  const audio = recording.audioBlob instanceof Blob ? recording.audioBlob : null;
  if (!audio || audio.size === 0) {
    throw new LessonReplaceError("The new recording has no narration to put up", [], null);
  }
  if (recording.cameraBlob instanceof Blob) {
    // A camera video goes up under the lesson's fixed name, which would change
    // what a viewer of the current lesson streams before its `.ne` changes.
    throw new LessonReplaceError(
      "The new recording has camera video; only narrated recordings can replace a lesson in place",
      [],
      null,
    );
  }

  const files = await buildRecordingFiles(recording, lessonId, {
    audioBaseFilename: await contentAddressedAudioBase(lessonId, audio),
  });
  if (!files.audio) {
    throw new LessonReplaceError("The new recording has no narration to put up", [], null);
  }
  const audioTarget: UploadTarget = { filename: files.audio.name, blob: files.audio.blob };
  const neTarget: UploadTarget = { filename: `${lessonId}.ne`, blob: files.ne };

  // Writing the same bytes again would still give the .ne a new ETag, so every
  // viewer would fetch the lesson again for nothing.
  if (
    input.publishedNe &&
    input.previousAudioFile === audioTarget.filename &&
    sameBytes(new Uint8Array(await files.ne.arrayBuffer()), input.publishedNe)
  ) {
    return { outcome: "unchanged", audioFile: audioTarget.filename };
  }

  // Checked before the first PUT: the edge refuses an oversized body with a
  // bare 413, after the narration ahead of it went up for nothing.
  const oversized = [audioTarget, neTarget].find((target) => target.blob.size > MAX_MEDIA_BYTES);
  if (oversized) {
    throw new UploadLimitError(
      `${oversized.filename} is ${formatMediaBytes(oversized.blob.size)}, over the ` +
        `${formatMediaBytes(MAX_MEDIA_BYTES)} upload limit`,
    );
  }

  const totalBytes = audioTarget.blob.size + neTarget.blob.size || 1;
  const report = (loaded: number) => input.onProgress?.(Math.min(1, loaded / totalBytes));
  report(0);

  const done: string[] = [];
  const step = async <T>(failure: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new LessonReplaceError(failure, [...done], error);
    }
  };

  await step(`Putting the narration ${audioTarget.filename} failed`, () =>
    uploadFile(lessonId, audioTarget, report, signal),
  );
  done.push(`put the new narration ${audioTarget.filename} (nothing names it yet)`);

  await step(`Putting the lesson file ${neTarget.filename} failed`, () =>
    uploadFile(lessonId, neTarget, (loaded) => report(audioTarget.blob.size + loaded), signal),
  );
  done.push(
    `put the new lesson file ${neTarget.filename}, so the lesson plays the new recording with ${audioTarget.filename}`,
  );

  const duration = formatDuration(recording.duration);
  await step(`Setting the lesson's duration to ${duration} failed`, () =>
    updateLessonDuration(lessonId, duration),
  );
  done.push(`set the lesson's duration to ${duration}`);

  const previous = input.previousAudioFile;
  return {
    outcome: "replaced",
    audioFile: audioTarget.filename,
    // Same name means same bytes: the PUT above overwrote it with itself.
    previousAudioFile: previous && previous !== audioTarget.filename ? previous : null,
    duration,
  };
}
