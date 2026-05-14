import type { Recording } from "../core/src";

const RECORDING_DATABASE_NAME = "next-editor-recordings-db";
const RECORDING_DATABASE_VERSION = 1;
const RECORDING_METADATA_STORE = "recording-metadata";
const RECORDING_PAYLOAD_STORE = "recording-payload";
const RECORDING_SYSTEM_STORE = "recording-system";

interface StoredRecordingPayload {
  id: string;
  binaryData: ArrayBuffer;
}

interface StoredSystemValue {
  key: string;
  value: unknown;
}

export interface StoredRecordingMetadata {
  id: string;
  name: string;
  version: Recording["version"];
  duration: number;
  createdAt: number;
  updatedAt: number;
  hasAudio: boolean;
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
      const request = this.getIndexedDB().open(
        RECORDING_DATABASE_NAME,
        RECORDING_DATABASE_VERSION,
      );

      request.onupgradeneeded = () => {
        const database = request.result;

        if (!database.objectStoreNames.contains(RECORDING_METADATA_STORE)) {
          database.createObjectStore(RECORDING_METADATA_STORE, {
            keyPath: "id",
          });
        }

        if (!database.objectStoreNames.contains(RECORDING_PAYLOAD_STORE)) {
          database.createObjectStore(RECORDING_PAYLOAD_STORE, {
            keyPath: "id",
          });
        }

        if (!database.objectStoreNames.contains(RECORDING_SYSTEM_STORE)) {
          database.createObjectStore(RECORDING_SYSTEM_STORE, {
            keyPath: "key",
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

  private fromStoredPayload(
    payload: StoredRecordingPayload | undefined,
  ): Uint8Array | null {
    if (!payload) {
      return null;
    }

    return new Uint8Array(payload.binaryData);
  }

  async hasEntries(): Promise<boolean> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      RECORDING_METADATA_STORE,
      "readonly",
    );
    const store = transaction.objectStore(RECORDING_METADATA_STORE);
    const count = await this.requestToPromise(store.count());
    await this.transactionToPromise(transaction);
    return count > 0;
  }

  async listMetadata(): Promise<StoredRecordingMetadata[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      RECORDING_METADATA_STORE,
      "readonly",
    );
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
      [RECORDING_METADATA_STORE, RECORDING_PAYLOAD_STORE],
      "readonly",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const payloadStore = transaction.objectStore(RECORDING_PAYLOAD_STORE);

    const metadata = await this.requestToPromise(metadataStore.get(id));
    const payload = await this.requestToPromise(payloadStore.get(id));
    await this.transactionToPromise(transaction);

    if (!metadata || !payload) {
      return null;
    }

    return {
      metadata,
      binaryData: new Uint8Array(payload.binaryData),
    };
  }

  async getAllEntries(): Promise<StoredRecordingEntry[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_PAYLOAD_STORE],
      "readonly",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const payloadStore = transaction.objectStore(RECORDING_PAYLOAD_STORE);

    const metadata = await this.requestToPromise(metadataStore.getAll());
    const payloads = await this.requestToPromise(payloadStore.getAll());
    await this.transactionToPromise(transaction);

    const payloadById = new Map(
      payloads.map((payload) => [
        payload.id,
        new Uint8Array(payload.binaryData),
      ]),
    );
    const missingPayloadIds = metadata
      .filter((entry) => !payloadById.has(entry.id))
      .map((entry) => entry.id);

    if (missingPayloadIds.length > 0) {
      throw new Error(
        `Missing recording payloads for ids: ${missingPayloadIds.join(", ")}`,
      );
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
        binaryData: payloadById.get(entry.id)!,
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
      [RECORDING_METADATA_STORE, RECORDING_PAYLOAD_STORE],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(RECORDING_METADATA_STORE);
    const payloadStore = transaction.objectStore(RECORDING_PAYLOAD_STORE);

    for (const entry of entries) {
      metadataStore.put(entry.metadata);
      payloadStore.put({
        id: entry.metadata.id,
        binaryData: this.toArrayBuffer(entry.binaryData),
      } satisfies StoredRecordingPayload);
    }

    await this.transactionToPromise(transaction);
  }

  async delete(id: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [RECORDING_METADATA_STORE, RECORDING_PAYLOAD_STORE],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).delete(id);
    transaction.objectStore(RECORDING_PAYLOAD_STORE).delete(id);
    await this.transactionToPromise(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [
        RECORDING_METADATA_STORE,
        RECORDING_PAYLOAD_STORE,
        RECORDING_SYSTEM_STORE,
      ],
      "readwrite",
    );
    transaction.objectStore(RECORDING_METADATA_STORE).clear();
    transaction.objectStore(RECORDING_PAYLOAD_STORE).clear();
    transaction.objectStore(RECORDING_SYSTEM_STORE).clear();
    await this.transactionToPromise(transaction);
  }

  async getStoredPayload(id: string): Promise<Uint8Array | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      RECORDING_PAYLOAD_STORE,
      "readonly",
    );
    const store = transaction.objectStore(RECORDING_PAYLOAD_STORE);
    const payload = await this.requestToPromise(store.get(id));
    await this.transactionToPromise(transaction);
    return this.fromStoredPayload(payload);
  }

  async getSystemValue<T>(key: string): Promise<T | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      RECORDING_SYSTEM_STORE,
      "readonly",
    );
    const store = transaction.objectStore(RECORDING_SYSTEM_STORE);
    const record = await this.requestToPromise(store.get(key));
    await this.transactionToPromise(transaction);
    return (record?.value as T | undefined) ?? null;
  }

  async setSystemValue(key: string, value: unknown): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      RECORDING_SYSTEM_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(RECORDING_SYSTEM_STORE);
    store.put({ key, value } satisfies StoredSystemValue);
    await this.transactionToPromise(transaction);
  }

  async deleteSystemValue(key: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      RECORDING_SYSTEM_STORE,
      "readwrite",
    );
    transaction.objectStore(RECORDING_SYSTEM_STORE).delete(key);
    await this.transactionToPromise(transaction);
  }
}

export const createIndexedDBRecordingStore = () =>
  new IndexedDBRecordingStore();
