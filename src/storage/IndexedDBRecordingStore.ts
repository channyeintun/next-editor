import type { Recording } from "../core/src";
import { requestToPromise, toArrayBuffer, transactionToPromise } from "./idb";
import {
  deleteRecordingOpfs,
  isRecordingOpfsAvailable,
  openRecordingOpfsStream,
  replaceRecordingOpfs,
} from "./recordingOpfs";

const RECORDING_DATABASE_NAME = "next-editor-recordings-db";
// v5: recording schema renumbered to 4 (binary-only .ne, mandatory dmp check ops).
// v6: added the recording-stream-state store. Nothing reads it and nothing adds
// rows to it any more (see the upgrade).
// v7: record payload size/location so large streams can move to OPFS.
// Pre-v5 recordings remain unsupported.
const RECORDING_DATABASE_VERSION = 7;
const RECORDING_METADATA_STORE = "recording-metadata";
const RECORDING_SEGMENTS_STORE = "recording-segments";
const RECORDING_STREAM_STATE_STORE = "recording-stream-state";
// Media is stored outside the SCR3 byte stream, as standalone Blobs keyed by recording id.
const RECORDING_CAMERA_STORE = "recording-camera";
const RECORDING_AUDIO_STORE = "recording-audio";
export const RECORDING_OPFS_THRESHOLD_BYTES = 8 * 1024 * 1024;

type RecordingPayloadStorage = "indexeddb" | "opfs";

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
  /** Missing on v5 entries, which are IndexedDB-backed. */
  payloadStorage?: RecordingPayloadStorage;
}

export interface StoredRecordingEntry {
  metadata: StoredRecordingMetadata;
  binaryData?: Uint8Array;
  /** OPFS-backed payloads are streamed instead of concatenated in memory. */
  binaryStream?: ReadableStream<Uint8Array>;
  /** Camera video stored alongside the (media-free) stream; absent when there is no camera. */
  cameraBlob?: Blob;
  /** Audio stored alongside the (media-free) stream; absent when there is no audio. */
  audioBlob?: Blob;
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

      request.onupgradeneeded = (event) => {
        const database = request.result;
        const upgradeTransaction = request.transaction;
        const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
        const discardUnsupportedRecordings = oldVersion > 0 && oldVersion < 5;

        if (upgradeTransaction && discardUnsupportedRecordings) {
          // Recordings older than v5 are not retained across an upgrade. Clear every
          // store they could have rows in (camera since v3, audio since v4): a blob
          // left behind has no metadata left to find it by, so nothing could delete it.
          for (const storeName of [
            RECORDING_METADATA_STORE,
            RECORDING_SEGMENTS_STORE,
            RECORDING_CAMERA_STORE,
            RECORDING_AUDIO_STORE,
          ]) {
            if (database.objectStoreNames.contains(storeName)) {
              upgradeTransaction.objectStore(storeName).clear();
            }
          }
        }

        if (!database.objectStoreNames.contains(RECORDING_METADATA_STORE)) {
          database.createObjectStore(RECORDING_METADATA_STORE, {
            keyPath: "id",
          });
        }

        // Drop the pre-2 single-blob payload store; the segment store is the only payload.
        if (database.objectStoreNames.contains("recording-payload")) {
          database.deleteObjectStore("recording-payload");
        }

        if (!database.objectStoreNames.contains(RECORDING_SEGMENTS_STORE)) {
          database.createObjectStore(RECORDING_SEGMENTS_STORE, {
            keyPath: ["recordingId", "seq"],
          });
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

        // Held per-recording state for incremental appends while recording, which
        // are gone. Nothing reads it and nothing adds rows; delete() only clears
        // rows earlier builds left. It stays in the v7 schema only because every
        // earlier build names it in its save and delete transactions, and would
        // fail both if a rollback met a database without it. Drop it in the next
        // version bump that has a reason of its own.
        if (!database.objectStoreNames.contains(RECORDING_STREAM_STATE_STORE)) {
          database.createObjectStore(RECORDING_STREAM_STATE_STORE, {
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
        // Clear the cache before rejecting, exactly as `onerror` above and
        // workspaceAssetStore's own openDatabase do. Without this, `getDatabase`
        // keeps handing out this one rejected promise for the rest of the
        // session — so every later save/load fails long after the blocking
        // connection has gone, and only a reload recovers.
        this.databasePromise = null;
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

  private async getIndexedDBPayload(
    database: IDBDatabase,
    recordingId: string,
  ): Promise<Uint8Array | null> {
    const transaction = database.transaction(RECORDING_SEGMENTS_STORE, "readonly");
    const segments = await requestToPromise(
      transaction.objectStore(RECORDING_SEGMENTS_STORE).getAll(this.segmentRange(recordingId)),
    );
    await transactionToPromise(transaction);
    return this.concatSegments(segments);
  }

  async getEntry(id: string): Promise<StoredRecordingEntry | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_CAMERA_STORE, RECORDING_AUDIO_STORE],
      "readonly",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const cameraStore = transaction.objectStore(RECORDING_CAMERA_STORE);
    const audioStore = transaction.objectStore(RECORDING_AUDIO_STORE);

    const metadata = await requestToPromise(metadataStore.get(id));
    const camera = await requestToPromise(cameraStore.get(id));
    const audio = await requestToPromise(audioStore.get(id));
    await transactionToPromise(transaction);

    if (!metadata) {
      return null;
    }

    if (metadata.payloadStorage === "opfs") {
      const binaryStream = await openRecordingOpfsStream(id);
      return binaryStream
        ? { metadata, binaryStream, cameraBlob: camera?.blob, audioBlob: audio?.blob }
        : null;
    }

    const binaryData = await this.getIndexedDBPayload(database, id);
    if (!binaryData) return null;
    return { metadata, binaryData, cameraBlob: camera?.blob, audioBlob: audio?.blob };
  }

  async put(entry: StoredRecordingEntry): Promise<void> {
    const { binaryData } = entry;
    const recordingId = entry.metadata.id;
    if (!binaryData) {
      throw new Error(`Recording ${recordingId} has no finalized binary payload`);
    }

    const payloadStorage = await this.storeLargePayloadInOpfs(recordingId, binaryData);
    try {
      await this.commitEntry(entry, binaryData, payloadStorage);
    } catch (error) {
      // No metadata row points at the file just written, and nothing else would
      // ever remove it: take it back out rather than leak it for good.
      if (payloadStorage === "opfs") await deleteRecordingOpfs(recordingId).catch(() => {});
      throw error;
    }

    if (payloadStorage === "indexeddb") {
      // An earlier, larger save of this id may have left its payload in OPFS.
      await deleteRecordingOpfs(recordingId).catch(() => {});
    }
  }

  /**
   * Writes a payload at or above the OPFS threshold to OPFS and reports where the
   * payload lives. Smaller payloads, and any OPFS failure, stay in IndexedDB.
   */
  private async storeLargePayloadInOpfs(
    recordingId: string,
    binaryData: Uint8Array,
  ): Promise<RecordingPayloadStorage> {
    if (
      binaryData.byteLength < RECORDING_OPFS_THRESHOLD_BYTES ||
      !(await isRecordingOpfsAvailable())
    ) {
      return "indexeddb";
    }
    try {
      const storedSize = await replaceRecordingOpfs(recordingId, binaryData);
      if (storedSize !== binaryData.byteLength) {
        throw new Error(`OPFS stored ${storedSize} of ${binaryData.byteLength} bytes`);
      }
      return "opfs";
    } catch {
      // Quota, permissions, or a terminated worker fall back to IndexedDB.
      return "indexeddb";
    }
  }

  /** Writes the entry's metadata, segment and media rows in one transaction. */
  private async commitEntry(
    entry: StoredRecordingEntry,
    binaryData: Uint8Array,
    payloadStorage: RecordingPayloadStorage,
  ): Promise<void> {
    const recordingId = entry.metadata.id;
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
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);
    const cameraStore = transaction.objectStore(RECORDING_CAMERA_STORE);
    const audioStore = transaction.objectStore(RECORDING_AUDIO_STORE);

    transaction.objectStore(RECORDING_METADATA_STORE).put({
      ...entry.metadata,
      payloadSize: binaryData.byteLength,
      payloadStorage,
    } satisfies StoredRecordingMetadata);
    // Finalized stream replaces any segments previously written for this id.
    segmentsStore.delete(this.segmentRange(recordingId));
    if (payloadStorage === "indexeddb") {
      segmentsStore.put({
        recordingId,
        seq: 0,
        bytes: toArrayBuffer(binaryData),
      } satisfies StoredRecordingSegment);
    }
    // Media lives in its own stores; replace or clear each to match the entry.
    if (entry.cameraBlob) {
      cameraStore.put({ recordingId, blob: entry.cameraBlob } satisfies StoredCameraVideo);
    } else {
      cameraStore.delete(recordingId);
    }
    if (entry.audioBlob) {
      audioStore.put({ recordingId, blob: entry.audioBlob } satisfies StoredAudio);
    } else {
      audioStore.delete(recordingId);
    }

    await transactionToPromise(transaction);
  }

  async delete(id: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [
        RECORDING_METADATA_STORE,
        RECORDING_SEGMENTS_STORE,
        RECORDING_STREAM_STATE_STORE,
        RECORDING_CAMERA_STORE,
        RECORDING_AUDIO_STORE,
      ],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).delete(id);
    transaction.objectStore(RECORDING_SEGMENTS_STORE).delete(this.segmentRange(id));
    // Earlier builds wrote a stream-state row with every save.
    transaction.objectStore(RECORDING_STREAM_STATE_STORE).delete(id);
    transaction.objectStore(RECORDING_CAMERA_STORE).delete(id);
    transaction.objectStore(RECORDING_AUDIO_STORE).delete(id);
    await transactionToPromise(transaction);
    await deleteRecordingOpfs(id);
  }
}

export const createIndexedDBRecordingStore = () => new IndexedDBRecordingStore();
