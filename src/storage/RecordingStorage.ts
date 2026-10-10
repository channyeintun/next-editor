import type { Recording } from "../core/src";
import {
  createIndexedDBRecordingStore,
  type StoredRecordingEntry,
  type StoredRecordingMetadata,
} from "./IndexedDBRecordingStore";
import {
  decompressBinaryToRecording,
  encodeRecordingToStream,
  normalizeRecording,
} from "./recordingCodecClient";
import { createStreamingRecordingReader } from "./streamingRecordingCodec";
import {
  hydrateDecodedRecordingWorkspaceAssets,
  persistDecodedWorkspaceAssets,
} from "./recordingWorkspaceAssets";

/** True when a recording carries non-empty media bytes. */
function hasMediaPayload(blob: unknown): boolean {
  return blob instanceof Blob && blob.size > 0;
}

/**
 * Keeps a take in IndexedDB so it survives a page load: the upload flow saves it
 * before the sign-in redirect and /code loads (then deletes) it on the way back.
 * Writing a recording out as files is recordingExport.ts; reading one in is
 * recordingImport.ts.
 */
export class RecordingStorage {
  private indexedDBStore = createIndexedDBRecordingStore();

  private createStoredMetadata(recording: Recording, payloadSize: number): StoredRecordingMetadata {
    return {
      id: recording.id,
      name: recording.name,
      version: recording.version,
      duration: recording.duration,
      createdAt: recording.createdAt,
      updatedAt: Date.now(),
      hasAudio: hasMediaPayload(recording.audioBlob),
      hasCamera: hasMediaPayload(recording.cameraBlob),
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
      decoded = await decompressBinaryToRecording(entry.binaryData);
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
}

let sharedStorage: RecordingStorage | null = null;

/** The page's one recording store: every caller shares its IndexedDB connection. */
export function getRecordingStorage(): RecordingStorage {
  sharedStorage ??= new RecordingStorage();
  return sharedStorage;
}
