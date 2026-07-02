import type { Recording } from "../core/src";
import { requestToPromise, toArrayBuffer, transactionToPromise } from "./idb";

const RECORDING_DATABASE_NAME = "next-editor-recordings-db";
// v5: recording schema renumbered to 4 (binary-only .ne, mandatory dmp check ops);
// pre-v5 recordings are not retained (no legacy decoding).
const RECORDING_DATABASE_VERSION = 5;
const RECORDING_METADATA_STORE = "recording-metadata";
const RECORDING_SEGMENTS_STORE = "recording-segments";
// Media is stored outside the SCR3 byte stream, as standalone Blobs keyed by recording id.
const RECORDING_CAMERA_STORE = "recording-camera";
const RECORDING_AUDIO_STORE = "recording-audio";

interface StoredRecordingSegment {
  recordingId: string;
  seq: number;
  bytes: ArrayBuffer;
}

interface StoredCameraVideo {
  recordingId: string;
  blob: Blob;
}

interface StoredAudio {
  recordingId: string;
  blob: Blob;
}

export interface StoredRecordingMetadata {
  id: string;
  name: string;
  version: Recording["version"];
  duration: number;
  createdAt: number;
  updatedAt: number;
  hasAudio: boolean;
  hasCamera: boolean;
  payloadSize: number;
}

export interface StoredRecordingEntry {
  metadata: StoredRecordingMetadata;
  binaryData: Uint8Array;
  /** Camera video stored alongside the (media-free) stream; absent when there is no camera. */
  cameraBlob?: Blob;
  /** Audio stored alongside the (media-free) stream; absent when there is no audio. */
  audioBlob?: Blob;
}

/** Most-recently-updated first, breaking ties by creation time (newest first). */
function compareMetadataByRecency(
  left: StoredRecordingMetadata,
  right: StoredRecordingMetadata,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }

  return right.createdAt - left.createdAt;
}

export class IndexedDBRecordingStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private getIndexedDB(): IDBFactory {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available in this environment");
    }

    return indexedDB;
  }

  private async getDatabase(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = this.openDatabase();
    }

    return this.databasePromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.getIndexedDB().open(RECORDING_DATABASE_NAME, RECORDING_DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        const upgradeTransaction = request.transaction;

        if (!database.objectStoreNames.contains(RECORDING_METADATA_STORE)) {
          database.createObjectStore(RECORDING_METADATA_STORE, {
            keyPath: "id",
          });
        } else if (upgradeTransaction) {
          // Old recordings are not retained across an upgrade; discard the dangling metadata.
          upgradeTransaction.objectStore(RECORDING_METADATA_STORE).clear();
        }

        // Drop the pre-2 single-blob payload store; the segment store is the only payload.
        if (database.objectStoreNames.contains("recording-payload")) {
          database.deleteObjectStore("recording-payload");
        }

        if (!database.objectStoreNames.contains(RECORDING_SEGMENTS_STORE)) {
          database.createObjectStore(RECORDING_SEGMENTS_STORE, {
            keyPath: ["recordingId", "seq"],
          });
        } else if (upgradeTransaction) {
          // Stream segments of non-retained old recordings are dropped along with their metadata.
          upgradeTransaction.objectStore(RECORDING_SEGMENTS_STORE).clear();
        }

        // v3: camera video moved out of the SCR3 stream into its own store.
        if (!database.objectStoreNames.contains(RECORDING_CAMERA_STORE)) {
          database.createObjectStore(RECORDING_CAMERA_STORE, {
            keyPath: "recordingId",
          });
        }

        // v4: audio moved out of the SCR3 stream into its own store.
        if (!database.objectStoreNames.contains(RECORDING_AUDIO_STORE)) {
          database.createObjectStore(RECORDING_AUDIO_STORE, {
            keyPath: "recordingId",
          });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = null;
        };
        resolve(database);
      };

      request.onerror = () => {
        this.databasePromise = null;
        reject(request.error ?? new Error("Failed to open recording database"));
      };

      request.onblocked = () => {
        reject(new Error("Recording database upgrade is blocked"));
      };
    });
  }

  private segmentRange(recordingId: string): IDBKeyRange {
    // Composite-key range covering every [recordingId, seq] segment for one recording.
    // An empty array sorts after any number, so it bounds the seq dimension above.
    return IDBKeyRange.bound([recordingId], [recordingId, []]);
  }

  private concatSegments(segments: StoredRecordingSegment[]): Uint8Array | null {
    if (segments.length === 0) {
      return null;
    }

    const ordered = [...segments].sort((left, right) => left.seq - right.seq);
    const totalLength = ordered.reduce((sum, segment) => sum + segment.bytes.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const segment of ordered) {
      result.set(new Uint8Array(segment.bytes), offset);
      offset += segment.bytes.byteLength;
    }

    return result;
  }

  async listMetadata(): Promise<StoredRecordingMetadata[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(RECORDING_METADATA_STORE, "readonly");
    const store = transaction.objectStore(RECORDING_METADATA_STORE);
    const metadata = await requestToPromise(store.getAll());
    await transactionToPromise(transaction);

    return metadata.sort(compareMetadataByRecency);
  }

  async getEntry(id: string): Promise<StoredRecordingEntry | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [
        RECORDING_METADATA_STORE,
        RECORDING_SEGMENTS_STORE,
        RECORDING_CAMERA_STORE,
        RECORDING_AUDIO_STORE,
      ],
      "readonly",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);
    const cameraStore = transaction.objectStore(RECORDING_CAMERA_STORE);
    const audioStore = transaction.objectStore(RECORDING_AUDIO_STORE);

    const metadata = await requestToPromise(metadataStore.get(id));
    const segments = await requestToPromise(segmentsStore.getAll(this.segmentRange(id)));
    const camera = await requestToPromise(cameraStore.get(id));
    const audio = await requestToPromise(audioStore.get(id));
    await transactionToPromise(transaction);

    if (!metadata) {
      return null;
    }

    const binaryData = this.concatSegments(segments);
    if (!binaryData) {
      return null;
    }

    return { metadata, binaryData, cameraBlob: camera?.blob, audioBlob: audio?.blob };
  }

  async put(entry: StoredRecordingEntry): Promise<void> {
    await this.putMany([entry]);
  }

  async putMany(entries: StoredRecordingEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const database = await this.getDatabase();
    const transaction = database.transaction(
      [
        RECORDING_METADATA_STORE,
        RECORDING_SEGMENTS_STORE,
        RECORDING_CAMERA_STORE,
        RECORDING_AUDIO_STORE,
      ],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);
    const cameraStore = transaction.objectStore(RECORDING_CAMERA_STORE);
    const audioStore = transaction.objectStore(RECORDING_AUDIO_STORE);

    for (const entry of entries) {
      metadataStore.put(entry.metadata);
      // Finalized stream replaces any segments previously written for this id.
      segmentsStore.delete(this.segmentRange(entry.metadata.id));
      segmentsStore.put({
        recordingId: entry.metadata.id,
        seq: 0,
        bytes: toArrayBuffer(entry.binaryData),
      } satisfies StoredRecordingSegment);
      // Media lives in its own stores; replace or clear each to match the entry.
      if (entry.cameraBlob) {
        cameraStore.put({
          recordingId: entry.metadata.id,
          blob: entry.cameraBlob,
        } satisfies StoredCameraVideo);
      } else {
        cameraStore.delete(entry.metadata.id);
      }
      if (entry.audioBlob) {
        audioStore.put({
          recordingId: entry.metadata.id,
          blob: entry.audioBlob,
        } satisfies StoredAudio);
      } else {
        audioStore.delete(entry.metadata.id);
      }
    }

    await transactionToPromise(transaction);
  }

  /**
   * Appends streamed bytes as the next segment for a recording, for crash-resilient
   * incremental persistence while recording. Segments concatenate (in seq order) into
   * the same SCR3 byte layout the exporter produces.
   */
  async appendSegments(recordingId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) {
      return;
    }

    const database = await this.getDatabase();
    const transaction = database.transaction(RECORDING_SEGMENTS_STORE, "readwrite");
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);
    const seq = await requestToPromise(segmentsStore.count(this.segmentRange(recordingId)));
    segmentsStore.put({
      recordingId,
      seq,
      bytes: toArrayBuffer(bytes),
    } satisfies StoredRecordingSegment);
    await transactionToPromise(transaction);
  }

  async delete(id: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [
        RECORDING_METADATA_STORE,
        RECORDING_SEGMENTS_STORE,
        RECORDING_CAMERA_STORE,
        RECORDING_AUDIO_STORE,
      ],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).delete(id);
    transaction.objectStore(RECORDING_SEGMENTS_STORE).delete(this.segmentRange(id));
    transaction.objectStore(RECORDING_CAMERA_STORE).delete(id);
    transaction.objectStore(RECORDING_AUDIO_STORE).delete(id);
    await transactionToPromise(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [
        RECORDING_METADATA_STORE,
        RECORDING_SEGMENTS_STORE,
        RECORDING_CAMERA_STORE,
        RECORDING_AUDIO_STORE,
      ],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).clear();
    transaction.objectStore(RECORDING_SEGMENTS_STORE).clear();
    transaction.objectStore(RECORDING_CAMERA_STORE).clear();
    transaction.objectStore(RECORDING_AUDIO_STORE).clear();
    await transactionToPromise(transaction);
  }
}

export const createIndexedDBRecordingStore = () => new IndexedDBRecordingStore();
