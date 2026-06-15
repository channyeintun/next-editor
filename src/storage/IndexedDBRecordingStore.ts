import type { Recording } from "../core/src";

const RECORDING_DATABASE_NAME = "next-editor-recordings-db";
const RECORDING_DATABASE_VERSION = 2;
const RECORDING_METADATA_STORE = "recording-metadata";
const RECORDING_SEGMENTS_STORE = "recording-segments";

interface StoredRecordingSegment {
  recordingId: string;
  seq: number;
  bytes: ArrayBuffer;
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
          // Old recordings are not retained: their single-blob payloads are dropped
          // below, so discard the dangling metadata too.
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

  private requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        reject(request.error ?? new Error("IndexedDB request failed"));
      };
    });
  }

  private transactionToPromise(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      };
    });
  }

  private toArrayBuffer(binaryData: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(binaryData.byteLength);
    copy.set(binaryData);
    return copy.buffer;
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

  async hasEntries(): Promise<boolean> {
    const database = await this.getDatabase();
    const transaction = database.transaction(RECORDING_METADATA_STORE, "readonly");
    const store = transaction.objectStore(RECORDING_METADATA_STORE);
    const count = await this.requestToPromise(store.count());
    await this.transactionToPromise(transaction);
    return count > 0;
  }

  async listMetadata(): Promise<StoredRecordingMetadata[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(RECORDING_METADATA_STORE, "readonly");
    const store = transaction.objectStore(RECORDING_METADATA_STORE);
    const metadata = await this.requestToPromise(store.getAll());
    await this.transactionToPromise(transaction);

    return metadata.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }

      return right.createdAt - left.createdAt;
    });
  }

  async getEntry(id: string): Promise<StoredRecordingEntry | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_SEGMENTS_STORE],
      "readonly",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);

    const metadata = await this.requestToPromise(metadataStore.get(id));
    const segments = await this.requestToPromise(segmentsStore.getAll(this.segmentRange(id)));
    await this.transactionToPromise(transaction);

    if (!metadata) {
      return null;
    }

    const binaryData = this.concatSegments(segments);
    if (!binaryData) {
      return null;
    }

    return { metadata, binaryData };
  }

  async getAllEntries(): Promise<StoredRecordingEntry[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_SEGMENTS_STORE],
      "readonly",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);

    const metadata = await this.requestToPromise(metadataStore.getAll());
    const segments = await this.requestToPromise(segmentsStore.getAll());
    await this.transactionToPromise(transaction);

    const segmentsById = new Map<string, StoredRecordingSegment[]>();
    for (const segment of segments) {
      const existing = segmentsById.get(segment.recordingId);
      if (existing) {
        existing.push(segment);
      } else {
        segmentsById.set(segment.recordingId, [segment]);
      }
    }

    const binaryById = new Map<string, Uint8Array>();
    for (const entry of metadata) {
      const binaryData = this.concatSegments(segmentsById.get(entry.id) ?? []);
      if (binaryData) {
        binaryById.set(entry.id, binaryData);
      }
    }

    const missingPayloadIds = metadata
      .filter((entry) => !binaryById.has(entry.id))
      .map((entry) => entry.id);

    if (missingPayloadIds.length > 0) {
      throw new Error(`Missing recording payloads for ids: ${missingPayloadIds.join(", ")}`);
    }

    return metadata
      .sort((left, right) => {
        if (left.updatedAt !== right.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }

        return right.createdAt - left.createdAt;
      })
      .map((entry) => ({
        metadata: entry,
        binaryData: binaryById.get(entry.id)!,
      }));
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
      [RECORDING_METADATA_STORE, RECORDING_SEGMENTS_STORE],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const segmentsStore = transaction.objectStore(RECORDING_SEGMENTS_STORE);

    for (const entry of entries) {
      metadataStore.put(entry.metadata);
      // Finalized stream replaces any segments previously written for this id.
      segmentsStore.delete(this.segmentRange(entry.metadata.id));
      segmentsStore.put({
        recordingId: entry.metadata.id,
        seq: 0,
        bytes: this.toArrayBuffer(entry.binaryData),
      } satisfies StoredRecordingSegment);
    }

    await this.transactionToPromise(transaction);
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
    const seq = await this.requestToPromise(segmentsStore.count(this.segmentRange(recordingId)));
    segmentsStore.put({
      recordingId,
      seq,
      bytes: this.toArrayBuffer(bytes),
    } satisfies StoredRecordingSegment);
    await this.transactionToPromise(transaction);
  }

  async delete(id: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_SEGMENTS_STORE],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).delete(id);
    transaction.objectStore(RECORDING_SEGMENTS_STORE).delete(this.segmentRange(id));
    await this.transactionToPromise(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_SEGMENTS_STORE],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).clear();
    transaction.objectStore(RECORDING_SEGMENTS_STORE).clear();
    await this.transactionToPromise(transaction);
  }
}

export const createIndexedDBRecordingStore = () => new IndexedDBRecordingStore();
