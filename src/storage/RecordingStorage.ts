import type { Recording } from "../core/src";
import {
  createIndexedDBRecordingStore,
  type StoredRecordingEntry,
  type StoredRecordingMetadata,
} from "./IndexedDBRecordingStore";
import {
  decompressBinaryToRecordings,
  encodeRecordingToStream,
  normalizeRecording,
} from "./recordingCodecClient";
import {
  audioExtensionFromMime,
  cameraExtensionFromMime,
  isStreamingRecording,
} from "./streamingRecordingCodec/format";
import { createStreamingRecordingReader } from "./streamingRecordingCodec";
import { createImportedCameraObjectUrl } from "./cameraVideoUrl";
import {
  hydrateDecodedRecordingWorkspaceAssets,
  persistDecodedWorkspaceAssets,
} from "./recordingWorkspaceAssets";

interface StorageStats {
  count: number;
  totalSize: string;
  compressedSize?: string;
  compressionRatio?: string;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

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

/** True for companion files that are audio (by MIME, or by extension for `.weba` etc.). */
export function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(weba|ogg|m4a|mp3|wav)$/i.test(file.name);
}

/**
 * True when a recording carries non-empty media bytes. The blob is a real {@link Blob}
 * for in-memory recordings, or a `{ [sizeKey]: number }` size placeholder for recordings
 * whose bytes were stripped for the lightweight metadata snapshot.
 */
function hasMediaPayload(blob: unknown, sizeKey: "__audio_size" | "__camera_size"): boolean {
  if (blob instanceof Blob) {
    return blob.size > 0;
  }

  if (!blob || typeof blob !== "object" || !(sizeKey in blob)) {
    return false;
  }

  const size = (blob as Record<string, unknown>)[sizeKey];
  return typeof size === "number" && size > 0;
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

export function pickCompanionVideo(
  videos: File[],
  neFileName: string,
  cameraFile: string | undefined,
): File | null {
  return pickCompanionFile(videos, neFileName, cameraFile);
}

/**
 * Attach a companion camera video to a recording as an object URL on `cameraUrl`, when the
 * recording references an external camera (`cameraFile`) and a matching video file is present.
 */
export function attachCompanionVideo(
  recording: Recording,
  videos: File[],
  neFileName: string,
): Recording {
  if (!recording.cameraFile) return recording;
  const video = pickCompanionVideo(videos, neFileName, recording.cameraFile);
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
 * blobs (audio/camera) — the same encoding `RecordingStorage.exportAsFile` uses,
 * extracted as a pure function (no DOM, no download side effect) so callers that
 * need the bytes without triggering a browser download (e.g. an upload flow)
 * get byte-identical output rather than a second, divergent encoding path.
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
  // camera's `.webm`). The encoder then writes no inline `audioChunk` segments.
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
 * Recording storage for use-next-editor.
 * Provides IndexedDB persistence plus export/import support for recordings.
 */
export class RecordingStorage {
  private indexedDBStore = createIndexedDBRecordingStore();

  private formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  private createStoredMetadata(recording: Recording, payloadSize: number): StoredRecordingMetadata {
    return {
      id: recording.id,
      name: recording.name,
      version: recording.version,
      duration: recording.duration,
      createdAt: recording.createdAt,
      updatedAt: Date.now(),
      hasAudio: hasMediaPayload(recording.audioBlob, "__audio_size"),
      hasCamera: hasMediaPayload(recording.cameraBlob, "__camera_size"),
      payloadSize,
    };
  }

  private async createStoredEntry(recording: Recording): Promise<StoredRecordingEntry> {
    const normalizedRecording = normalizeRecording(recording);
    // The stream is media-free; camera and audio are persisted separately as their own blobs.
    const binaryData = await encodeRecordingToStream(normalizedRecording);
    const cameraBlob =
      normalizedRecording.cameraBlob instanceof Blob ? normalizedRecording.cameraBlob : undefined;
    const audioBlob =
      normalizedRecording.audioBlob instanceof Blob ? normalizedRecording.audioBlob : undefined;

    return {
      metadata: this.createStoredMetadata(normalizedRecording, binaryData.byteLength),
      binaryData,
      cameraBlob,
      audioBlob,
    };
  }

  private async decodeStoredEntry(entry: StoredRecordingEntry): Promise<Recording> {
    let decoded: Recording;
    if (entry.binaryData) {
      const recordings = await decompressBinaryToRecordings(entry.binaryData);
      if (recordings.length !== 1) {
        throw new Error(
          `Expected one recording payload for ${entry.metadata.id}, received ${recordings.length}`,
        );
      }
      decoded = recordings[0];
    } else if (entry.binaryStream) {
      const streamReader = entry.binaryStream.getReader();
      const recordingReader = createStreamingRecordingReader();
      try {
        for (;;) {
          const { value, done } = await streamReader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            recordingReader.push(value);
            await persistDecodedWorkspaceAssets(recordingReader.readDelta()?.newWorkspaceAssets);
          }
        }
      } finally {
        streamReader.releaseLock();
      }
      const recording = recordingReader.getRecording();
      if (!recording?.streamFinalized) {
        throw new Error(`Stored OPFS recording ${entry.metadata.id} is incomplete`);
      }
      decoded = await hydrateDecodedRecordingWorkspaceAssets(recording);
    } else {
      throw new Error(`Recording ${entry.metadata.id} has no stored payload`);
    }

    let recording = normalizeRecording(decoded);
    // Reattach the separately-stored camera video (CameraOverlay turns the blob into an object URL).
    if (entry.cameraBlob) {
      recording = { ...recording, cameraBlob: entry.cameraBlob };
    }
    // Reattach the separately-stored audio blob so playback finds it inline again.
    if (entry.audioBlob) {
      recording = { ...recording, audioBlob: entry.audioBlob };
    }
    return recording;
  }

  /**
   * List stored recordings by metadata only — no stream/media bytes are read or decoded.
   * Use this for library UIs; decode individual recordings on demand via {@link loadById}.
   */
  async list(): Promise<StoredRecordingMetadata[]> {
    return this.indexedDBStore.listMetadata();
  }

  /**
   * Load and decode a single recording by id, reading only that recording's bytes.
   * Returns null when the id has no stored entry (or its payload is missing).
   */
  async loadById(id: string): Promise<Recording | null> {
    const entry = await this.indexedDBStore.getEntry(id);
    if (!entry) {
      return null;
    }
    return this.decodeStoredEntry(entry);
  }

  /**
   * Save a recording as an individual IndexedDB entry.
   */
  async save(recording: Recording): Promise<void> {
    try {
      const entry = await this.createStoredEntry(recording);
      await this.indexedDBStore.put(entry);
    } catch (error) {
      console.error("RecordingStorage: Failed to save recording:", error);
      throw new Error(
        `Failed to save recording: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Append already-encoded SCR3 stream bytes as the next segment of a recording, for
   * crash-resilient incremental persistence while recording.
   */
  async appendRecordingSegments(recordingId: string, bytes: Uint8Array): Promise<void> {
    await this.indexedDBStore.appendSegments(recordingId, bytes);
  }

  /**
   * Load all recordings from IndexedDB, decoding one at a time by id. A corrupt or
   * unreadable entry is skipped rather than failing the whole library; its id is
   * reported in `failedIds` so the caller can surface it.
   */
  async loadAll(): Promise<{ recordings: Recording[]; failedIds: string[] }> {
    try {
      const metadata = await this.indexedDBStore.listMetadata();
      const recordings: Recording[] = [];
      const failedIds: string[] = [];

      for (const entry of metadata) {
        try {
          const recording = await this.loadById(entry.id);
          if (recording) {
            recordings.push(recording);
          } else {
            failedIds.push(entry.id);
          }
        } catch (error) {
          console.error(`RecordingStorage: Failed to decode recording ${entry.id}:`, error);
          failedIds.push(entry.id);
        }
      }

      return { recordings, failedIds };
    } catch (error) {
      console.error("Failed to load recordings from IndexedDB:", error);
      return { recordings: [], failedIds: [] };
    }
  }

  /**
   * Load all recordings from IndexedDB. Prefer {@link list} + {@link loadById} (or
   * {@link loadAll} for the failure-isolated form) for library UIs.
   */
  async load(): Promise<Recording[]> {
    const { recordings } = await this.loadAll();
    return recordings;
  }

  /**
   * Delete one recording without rebuilding the entire archive.
   */
  async delete(id: string): Promise<void> {
    try {
      await this.indexedDBStore.delete(id);
    } catch (error) {
      throw new Error(
        `Failed to delete recording: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Export a recording. Camera video and audio are each written to their own sibling file so the
   * `.ne` stays small (audio dominates long recordings) and media can be streamed natively on
   * load: a full recording exports as `<name>.ne` + `<name>.<video-ext>` + `<name>.<audio-ext>`;
   * one without media as a single `.ne`.
   */
  async exportAsFile(recording: Recording, filename?: string): Promise<void> {
    try {
      const baseFilename = filename?.replace(/\.(json|ne)$/, "") || `recording-${recording.id}`;
      const files = await buildRecordingFiles(recording, baseFilename);

      this.downloadBlob(files.ne, `${baseFilename}.ne`);

      if (files.camera) {
        // Small gap so the browser doesn't collapse consecutive programmatic downloads into one.
        await new Promise((resolve) => setTimeout(resolve, 150));
        this.downloadBlob(files.camera.blob, files.camera.name);
      }

      if (files.audio) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        this.downloadBlob(files.audio.blob, files.audio.name);
      }
    } catch (error) {
      throw new Error(
        `Failed to export recording: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /** Trigger a browser download for a blob under the given filename. */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Import recordings from a `.ne` file, optionally paired with sibling media files. The picker
   * allows selecting them together; the camera video is matched to the recording's `cameraFile`
   * (or by basename) and exposed via an object URL on `cameraUrl`, and the audio file is matched
   * to `audioFile` and attached as `audioBlob`. Missing media is not an error — the recording
   * loads and plays without it.
   */
  importFromFile(): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".ne,.webm,.mp4,.mov,video/*,.weba,.ogg,.m4a,.mp3,.wav,audio/*";

      input.onchange = async (event) => {
        const files = Array.from((event.target as HTMLInputElement).files ?? []);
        const neFile = files.find((file) => file.name.toLowerCase().endsWith(".ne"));
        if (!neFile) {
          reject(new Error("No .ne file selected"));
          return;
        }
        const companions = files.filter((file) => file !== neFile);
        const audioFiles = companions.filter(isAudioFile);
        const videoFiles = companions.filter((file) => !isAudioFile(file));

        try {
          const bytes = new Uint8Array(await neFile.arrayBuffer());
          if (bytes.length === 0) {
            reject(new Error("File appears to be empty or corrupted"));
            return;
          }
          if (!isStreamingRecording(bytes)) {
            reject(new Error("File is not a valid .ne recording (bad SCR3 magic)"));
            return;
          }

          const importedRecordings = await decompressBinaryToRecordings(bytes);

          // Validate imported recordings
          if (!Array.isArray(importedRecordings) || importedRecordings.length === 0) {
            reject(new Error("No valid recordings found in file"));
            return;
          }

          // Attach companion media (if provided): camera video streams via object URL,
          // audio attaches as the playback blob.
          const withVideo = importedRecordings.map((recording) =>
            attachCompanionAudio(
              attachCompanionVideo(recording, videoFiles, neFile.name),
              audioFiles,
              neFile.name,
            ),
          );

          // Don't save to localStorage to avoid quota issues with large files
          // Just return the imported recordings for immediate use
          resolve(withVideo);
        } catch (error) {
          console.error("Import error details:", error);
          const errorMessage = error instanceof Error ? error.message : "Invalid file format";
          reject(new Error(`Failed to import recordings: ${errorMessage}`));
        }
      };

      input.click();
    });
  }

  /**
   * Clear all recordings from IndexedDB.
   */
  async clear(): Promise<void> {
    await this.indexedDBStore.clear();
  }

  /**
   * Get storage statistics from IndexedDB metadata.
   */
  async getStats(): Promise<StorageStats> {
    try {
      const storedMetadata = await this.indexedDBStore.listMetadata();

      if (storedMetadata.length === 0) {
        return {
          count: 0,
          totalSize: "0 B",
          compressedSize: "0 B",
          compressionRatio: "0%",
        };
      }

      const totalCompressedSize = storedMetadata.reduce(
        (total, metadata) => total + metadata.payloadSize,
        0,
      );

      return {
        count: storedMetadata.length,
        totalSize: this.formatSize(totalCompressedSize),
        compressedSize: this.formatSize(totalCompressedSize),
        compressionRatio: "N/A",
      };
    } catch (error) {
      console.error("Failed to read recording stats from IndexedDB:", error);
      return {
        count: 0,
        totalSize: "0 B",
        compressedSize: "0 B",
        compressionRatio: "0%",
      };
    }
  }
}

export const createRecordingStorage = () => new RecordingStorage();
