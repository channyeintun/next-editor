import type { Recording } from "../core/src";
import { decompressBinaryToRecording } from "./recordingCodecClient";
import { isStreamingRecording } from "./streamingRecordingCodec/format";
import { createImportedCameraObjectUrl } from "./cameraVideoUrl";
import {
  isRecordingAudioFileName,
  isRecordingVideoFileName,
  RECORDING_IMPORT_ACCEPT,
} from "../shared/recordingMediaFiles";

// Reading a recording in from files: a `.ne` picked or dropped together with its
// sibling camera video and narration, paired by the names the recording declares.
// The editor's import picker and the URL loader's drop path both go through here.

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

/** True for companion files that are audio (by MIME, or by extension for `.weba` etc.). */
function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || isRecordingAudioFileName(file.name);
}

/** True for companion files that are video (by MIME, or by extension). */
function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || isRecordingVideoFileName(file.name);
}

/**
 * Choose the media file that pairs with an imported `.ne`. Prefers an exact referenced-name
 * match, then a basename match against the `.ne`, then the sole candidate if only one was
 * provided. Returns null when nothing matches (the recording then plays without that media).
 */
function pickCompanionFile(
  candidates: File[],
  neFileName: string,
  referencedName: string | undefined,
): File | null {
  if (candidates.length === 0) return null;
  if (referencedName) {
    const exact = candidates.find((candidate) => candidate.name === referencedName);
    if (exact) return exact;
  }
  const baseName = stripExtension(neFileName);
  const byBase = candidates.find((candidate) => stripExtension(candidate.name) === baseName);
  if (byBase) return byBase;
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Attach a companion camera video to a recording as an object URL on `cameraUrl`, when the
 * recording references an external camera (`cameraFile`) and a matching video file is present.
 */
function attachCompanionVideo(recording: Recording, videos: File[], neFileName: string): Recording {
  if (!recording.cameraFile) return recording;
  const video = pickCompanionFile(videos, neFileName, recording.cameraFile);
  if (!video) return recording;
  return { ...recording, cameraUrl: createImportedCameraObjectUrl(video) };
}

/**
 * Attach a companion audio file to a recording, when the recording references external audio
 * (`audioFile`, or `audioSource === "external"` for older exports that omitted the filename)
 * and a matching file is present. The `File` is attached directly as `audioBlob`
 * (a `File` is a `Blob`), so the existing blob playback path works unchanged.
 */
export function attachCompanionAudio(
  recording: Recording,
  audios: File[],
  neFileName: string,
): Recording {
  const declaresExternalAudio = recording.audioFile || recording.audioSource === "external";
  if (!declaresExternalAudio || recording.audioBlob instanceof Blob) return recording;
  const audio = pickCompanionFile(audios, neFileName, recording.audioFile);
  if (!audio) return recording;
  return { ...recording, audioBlob: audio };
}

/** A `.ne` picked or dropped together with other files, and the media among those files. */
export interface RecordingFileSelection {
  neFile: File;
  videoFiles: File[];
  audioFiles: File[];
}

/**
 * Finds the `.ne` (in any letter case) among files picked or dropped together, and the
 * video and audio files that may be its siblings. Null when no file is a `.ne`.
 */
export function selectRecordingFiles(files: File[]): RecordingFileSelection | null {
  const neFile = files.find((file) => file.name.toLowerCase().endsWith(".ne"));
  if (!neFile) return null;
  const companions = files.filter((file) => file !== neFile);
  return {
    neFile,
    videoFiles: companions.filter((file) => isVideoFile(file) && !isAudioFile(file)),
    audioFiles: companions.filter(isAudioFile),
  };
}

/** Reads and decodes a `.ne` file, rejecting one that is empty or not an SCR3 stream. */
export async function decodeRecordingFile(neFile: File): Promise<Recording> {
  const bytes = new Uint8Array(await neFile.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("File appears to be empty or corrupted");
  }
  if (!isStreamingRecording(bytes)) {
    throw new Error("File is not a valid .ne recording (bad SCR3 magic)");
  }
  return decompressBinaryToRecording(bytes);
}

/**
 * Attaches the camera video (as an object URL on `cameraUrl`) and the audio (as `audioBlob`)
 * that pair with the recording decoded from `selection.neFile`, matched by the names the
 * recording declares, then by the `.ne`'s basename, then as the only candidate.
 */
export function attachCompanionMedia(
  recording: Recording,
  selection: RecordingFileSelection,
): Recording {
  const { neFile, videoFiles, audioFiles } = selection;
  return attachCompanionAudio(
    attachCompanionVideo(recording, videoFiles, neFile.name),
    audioFiles,
    neFile.name,
  );
}

/**
 * Import recordings from a `.ne` file, optionally paired with sibling media files. The picker
 * allows selecting them together; the camera video is matched to the recording's `cameraFile`
 * (or by basename) and exposed via an object URL on `cameraUrl`, and the audio file is matched
 * to `audioFile` and attached as `audioBlob`. Missing media is not an error — the recording
 * loads and plays without it.
 */
export function pickRecordingFiles(): Promise<Recording[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = RECORDING_IMPORT_ACCEPT;

    input.onchange = async (event) => {
      const files = Array.from((event.target as HTMLInputElement).files ?? []);
      const selection = selectRecordingFiles(files);
      if (!selection) {
        reject(new Error("No .ne file selected"));
        return;
      }

      try {
        const recording = await decodeRecordingFile(selection.neFile);
        resolve([attachCompanionMedia(recording, selection)]);
      } catch (error) {
        console.error("Import error details:", error);
        const errorMessage = error instanceof Error ? error.message : "Invalid file format";
        reject(new Error(`Failed to import recordings: ${errorMessage}`));
      }
    };

    input.click();
  });
}
