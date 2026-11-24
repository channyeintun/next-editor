import type { Recording } from "@app/core/src";
import { buildRecordingFiles } from "@app/storage/recordingExport";
import { withNarrationInMemory } from "@app/storage/recordingSiblingMedia";
import { sha256Hex } from "@app/shared/sha256Hex";
import { formatMediaBytes, MAX_MEDIA_BYTES } from "../../lessons/uploadLimits";
import { updateLessonDuration } from "../library/myLessonsApi";
import { deleteLessonAudioFile } from "./deleteMediaFile";
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
 * the old narration. Only then does the gallery's duration change, and the
 * old narration is deleted last, once nothing names it.
 */

export interface ReplaceLessonMediaInput {
  lessonId: string;
  /** The new recording, carrying the id it should keep and its narration. */
  recording: Recording;
  /** The narration file the lesson's current `.ne` names; null when it names none. */
  previousAudioFile: string | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface ReplacedLessonMedia {
  /** The narration file the lesson's `.ne` names now. */
  audioFile: string;
  /** The narration file that was deleted; null when none was, or deleting it failed. */
  removedAudioFile: string | null;
  /** The duration the lesson row shows now, as formatDuration writes it. */
  duration: string;
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

  let removedAudioFile: string | null = null;
  const previous = input.previousAudioFile;
  // Same name means same bytes: the PUT above overwrote it with itself.
  if (previous && previous !== audioTarget.filename) {
    try {
      await deleteLessonAudioFile(lessonId, previous);
      removedAudioFile = previous;
    } catch (error) {
      // The replacement already stands; the old narration is only an orphan.
      console.warn(`Could not delete the old narration ${previous}:`, error);
    }
  }

  return { audioFile: audioTarget.filename, removedAudioFile, duration };
}
