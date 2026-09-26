import type { Slide } from "../../core/src/slides";
import type { RecordingTrackName } from "../../core/src/machine/recordingAssembly";
import type { MediaSpan } from "../../core/src/utils/mediaSpans";
import { requestToPromise, transactionToPromise } from "../idb";

// ============================================================================
// Where a take's draft lives while it is recorded.
//
// A take is held in memory until it is uploaded or exported, so a crash, a
// reload or a closed tab used to lose it. The draft journal writes it here as
// it records: append-only track records and the recorders' media chunks, which
// is enough to rebuild the Recording in a later visit (recoverRecordingDraft).
// Its own database, so it never shares an upgrade with the recording library.
// ============================================================================

const DATABASE_NAME = "next-editor-recording-drafts";
const DATABASE_VERSION = 1;
const DRAFTS_STORE = "drafts";
const RECORDS_STORE = "records";
const MEDIA_STORE = "media";

export type RecordingDraftMediaTrack = "audio" | "camera";

export interface RecordingDraftMeta {
  id: string;
  /** `Date.now()` when the take started. */
  startedAt: number;
  /** `Date.now()` of the last write. */
  updatedAt: number;
  /** The take was stopped, so nothing more will be written to it. */
  finished: boolean;
  /** Recorded time at the last write. */
  durationMs: number;
  /** A microphone take's recorder output, or a selected narration file kept whole. */
  audio?: { mimeType: string; source: "microphone" | "external" };
  camera?: { mimeType: string; startOffsetMs: number };
  /** What retakes discarded from the recorders' files, applied when the draft is recovered. */
  mediaCuts?: MediaSpan[];
  /** The id of the Recording the take finalized into, in the tab that recorded it. */
  recordingId?: string;
}

/**
 * One journal write. `append` adds entries to a track after the ones before it;
 * `reset` replaces the track, for a take whose track was cut back; `slides` is the
 * deck as of that write, journaled only when it changes.
 */
export type RecordingDraftRecord =
  | { kind: "append" | "reset"; track: RecordingTrackName; entries: unknown[] }
  | { kind: "slides"; slides: Slide[] };

interface StoredDraftRecord {
  draftId: string;
  seq: number;
  record: RecordingDraftRecord;
}

interface StoredDraftMedia {
  draftId: string;
  track: RecordingDraftMediaTrack;
  seq: number;
  blob: Blob;
}

export interface StoredRecordingDraft {
  meta: RecordingDraftMeta;
  records: RecordingDraftRecord[];
  media: Record<RecordingDraftMediaTrack, Blob[]>;
}

/** Every key of a draft in the records and media stores: `[id, …]`. */
const draftKeyRange = (id: string) => IDBKeyRange.bound([id], [id, []]);

export class RecordingDraftStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private getDatabase(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available in this environment"));
        return;
      }
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DRAFTS_STORE)) {
          database.createObjectStore(DRAFTS_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(RECORDS_STORE)) {
          database.createObjectStore(RECORDS_STORE, { keyPath: ["draftId", "seq"] });
        }
        if (!database.objectStoreNames.contains(MEDIA_STORE)) {
          database.createObjectStore(MEDIA_STORE, { keyPath: ["draftId", "track", "seq"] });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to open the drafts database"));
    });
    return this.databasePromise;
  }

  /**
   * Writes the meta and the next records in one transaction, so a draft never
   * claims more recorded time than its records hold. `firstSeq` numbers the first
   * record; the journal keeps the running count.
   */
  async write(
    meta: RecordingDraftMeta,
    records: readonly RecordingDraftRecord[],
    firstSeq: number,
  ): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction([DRAFTS_STORE, RECORDS_STORE], "readwrite");
    transaction.objectStore(DRAFTS_STORE).put(meta);
    const recordStore = transaction.objectStore(RECORDS_STORE);
    records.forEach((record, index) => {
      const stored: StoredDraftRecord = { draftId: meta.id, seq: firstSeq + index, record };
      recordStore.put(stored);
    });
    await transactionToPromise(transaction);
  }

  async appendMedia(
    draftId: string,
    track: RecordingDraftMediaTrack,
    seq: number,
    blob: Blob,
  ): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(MEDIA_STORE, "readwrite");
    const stored: StoredDraftMedia = { draftId, track, seq, blob };
    transaction.objectStore(MEDIA_STORE).put(stored);
    await transactionToPromise(transaction);
  }

  async listDrafts(): Promise<RecordingDraftMeta[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(DRAFTS_STORE, "readonly");
    const metas = await requestToPromise(
      transaction.objectStore(DRAFTS_STORE).getAll() as IDBRequest<RecordingDraftMeta[]>,
    );
    return metas.sort((left, right) => right.startedAt - left.startedAt);
  }

  async readDraft(id: string): Promise<StoredRecordingDraft | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [DRAFTS_STORE, RECORDS_STORE, MEDIA_STORE],
      "readonly",
    );
    const [meta, storedRecords, storedMedia] = await Promise.all([
      requestToPromise(
        transaction.objectStore(DRAFTS_STORE).get(id) as IDBRequest<RecordingDraftMeta | undefined>,
      ),
      requestToPromise(
        transaction.objectStore(RECORDS_STORE).getAll(draftKeyRange(id)) as IDBRequest<
          StoredDraftRecord[]
        >,
      ),
      requestToPromise(
        transaction.objectStore(MEDIA_STORE).getAll(draftKeyRange(id)) as IDBRequest<
          StoredDraftMedia[]
        >,
      ),
    ]);
    if (!meta) return null;

    // Keys sort by [draftId, seq] and [draftId, track, seq], so both arrive in order.
    const media: Record<RecordingDraftMediaTrack, Blob[]> = { audio: [], camera: [] };
    for (const chunk of storedMedia) {
      media[chunk.track].push(chunk.blob);
    }
    return { meta, records: storedRecords.map((stored) => stored.record), media };
  }

  async deleteDraft(id: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(
      [DRAFTS_STORE, RECORDS_STORE, MEDIA_STORE],
      "readwrite",
    );
    transaction.objectStore(DRAFTS_STORE).delete(id);
    transaction.objectStore(RECORDS_STORE).delete(draftKeyRange(id));
    transaction.objectStore(MEDIA_STORE).delete(draftKeyRange(id));
    await transactionToPromise(transaction);
  }
}

let sharedStore: RecordingDraftStore | null = null;

/** The page's one draft store: every journal and the recovery prompt share its connection. */
export function getRecordingDraftStore(): RecordingDraftStore {
  sharedStore ??= new RecordingDraftStore();
  return sharedStore;
}

export function resetRecordingDraftStoreForTests(): void {
  sharedStore = null;
}
