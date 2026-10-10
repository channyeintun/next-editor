import type { Recording } from "../core/src";
import { encodeRecordingToStream } from "./recordingCodecClient";
import { downloadBlob } from "../utils/downloadBlob";
import { audioExtensionFromMime, cameraExtensionFromMime } from "../shared/recordingMediaFiles";

// Writing a recording out as files: the `.ne` stream plus its sibling camera video
// and narration. The upload flow and the studio renderer take the bytes from
// buildRecordingFiles; the editor's export downloads them.

/**
 * Drop `audioUrl`/`cameraUrl` on export — a `blob:`/`data:` object URL from an import, or a
 * `https://` URL auto-resolved by `useUrlLoader` while loading from a `?url=` host, can't
 * survive a re-export as-is: baking it in would silently defeat sibling-file resolution on the
 * next load, since a present `cameraUrl`/`audioUrl` is preferred over the sibling filename.
 */
function sanitizeMediaUrlsForExport(recording: Recording): Recording {
  const sanitized = { ...recording };
  delete sanitized.audioUrl;
  delete sanitized.cameraUrl;
  return sanitized;
}

export interface RecordingFileSet {
  /** The SCR3 byte stream — no base64 wrapping. */
  ne: Blob;
  audio?: { name: string; blob: Blob };
  camera?: { name: string; blob: Blob };
}

export interface BuildRecordingFilesOptions {
  /**
   * Sibling caption filenames the encoded `.ne` should declare via `captionFiles`
   * (the caller uploads those files next to the `.ne`). Replaces any declaration
   * already on the recording — after a re-upload under a new base filename, the
   * new siblings are the only ones guaranteed to exist.
   */
  captionFiles?: string[];
}

/**
 * Serializes a recording into its `.ne` stream plus externalized sibling media
 * blobs (audio/camera) — the same encoding `exportRecordingFiles` uses, as a pure
 * function (no DOM, no download side effect) so callers that need the bytes
 * without triggering a browser download (e.g. an upload flow) get byte-identical
 * output rather than a second, divergent encoding path.
 */
export async function buildRecordingFiles(
  recording: Recording,
  baseFilename: string,
  options?: BuildRecordingFilesOptions,
): Promise<RecordingFileSet> {
  // Externalize the camera blob into a sibling video file and reference it from the `.ne`.
  const cameraBlob = recording.cameraBlob instanceof Blob ? recording.cameraBlob : null;
  let recordingToEncode = sanitizeMediaUrlsForExport(recording);
  let videoName: string | null = null;
  if (cameraBlob) {
    videoName = `${baseFilename}.${cameraExtensionFromMime(cameraBlob.type)}`;
    recordingToEncode = {
      ...recordingToEncode,
      cameraBlob: undefined,
      cameraFile: videoName,
    };
  }

  // Externalize the audio blob the same way (`.weba` etc., so it never collides with the
  // camera's `.webm`). Audio never goes into the stream; the `.ne` records the sibling name.
  const audioBlob = recording.audioBlob instanceof Blob ? recording.audioBlob : null;
  let audioName: string | null = null;
  if (audioBlob && audioBlob.size > 0) {
    audioName = `${baseFilename}.${audioExtensionFromMime(audioBlob.type)}`;
    recordingToEncode = {
      ...recordingToEncode,
      audioBlob: undefined,
      audioFile: audioName,
    };
  }

  if (options?.captionFiles?.length) {
    recordingToEncode = {
      ...recordingToEncode,
      captionFiles: options.captionFiles,
    };
  }

  const streamBytes = await encodeRecordingToStream(recordingToEncode);
  const ne = new Blob([streamBytes as BlobPart], {
    type: "application/octet-stream",
  });

  return {
    ne,
    audio: audioBlob && audioName ? { name: audioName, blob: audioBlob } : undefined,
    camera: cameraBlob && videoName ? { name: videoName, blob: cameraBlob } : undefined,
  };
}

/**
 * Export a recording. Camera video and audio are each written to their own sibling file so the
 * `.ne` stays small (audio dominates long recordings) and media can be streamed natively on
 * load: a full recording exports as `<name>.ne` + `<name>.<video-ext>` + `<name>.<audio-ext>`;
 * one without media as a single `.ne`.
 */
export async function exportRecordingFiles(recording: Recording, filename?: string): Promise<void> {
  try {
    const baseFilename = filename?.replace(/\.(json|ne)$/, "") || `recording-${recording.id}`;
    const files = await buildRecordingFiles(recording, baseFilename);

    downloadBlob(files.ne, `${baseFilename}.ne`);

    if (files.camera) {
      // Small gap so the browser doesn't collapse consecutive programmatic downloads into one.
      await new Promise((resolve) => setTimeout(resolve, 150));
      downloadBlob(files.camera.blob, files.camera.name);
    }

    if (files.audio) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      downloadBlob(files.audio.blob, files.audio.name);
    }
  } catch (error) {
    throw new Error(
      `Failed to export recording: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
