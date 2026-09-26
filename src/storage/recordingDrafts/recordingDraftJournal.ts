import type { RecordingTracks } from "../../core/src/machine/recordingAssembly";
import type { Slide } from "../../core/src/slides";
import {
  getRecordingDraftStore,
  resetRecordingDraftStoreForTests,
  type RecordingDraftMediaTrack,
  type RecordingDraftMeta,
  type RecordingDraftStore,
} from "./recordingDraftStore";
import { RecordingDraftTrackWriter } from "./recordingDraftTracks";

// ============================================================================
// The draft journal of one take, and the page-wide bookkeeping around drafts.
//
// Writes are queued so they land in order, and each flush writes its records
// and the draft's meta in one transaction: a draft is always a consistent
// prefix of its take. A failed flush stops the journal instead of leaving a
// gap later records would be read on top of.
//
// A tab holds a Web Lock per draft it owns (one it is recording, or one it
// finalized or recovered and still has open), so another tab can tell a
// draft whose tab is gone from one that is still in use.
// ============================================================================

const LOCK_PREFIX = "next-editor-recording-draft:";

export interface RecordingDraftFlush {
  durationMs: number;
  audio?: RecordingDraftMeta["audio"];
  camera?: RecordingDraftMeta["camera"];
  slides?: Slide[];
  finished?: boolean;
  recordingId?: string;
}

const createDraftId = (startedAt: number) =>
  `draft-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;

export class RecordingDraftJournal {
  readonly id: string;
  private meta: RecordingDraftMeta;
  private readonly writer = new RecordingDraftTrackWriter();
  private nextSeq = 0;
  private readonly mediaSeq: Record<RecordingDraftMediaTrack, number> = { audio: 0, camera: 0 };
  private readonly mediaFailed: Record<RecordingDraftMediaTrack, boolean> = {
    audio: false,
    camera: false,
  };
  private recordsFailed = false;
  private discarded = false;
  private queue: Promise<void> = Promise.resolve();
  /** Null once the take is over: nothing reads it again, and it is the whole take. */
  private tracks: RecordingTracks | null;
  private readonly store: RecordingDraftStore;

  constructor(
    tracks: RecordingTracks,
    startedAt: number,
    store: RecordingDraftStore = getRecordingDraftStore(),
  ) {
    this.tracks = tracks;
    this.store = store;
    this.id = createDraftId(startedAt);
    this.meta = { id: this.id, startedAt, updatedAt: startedAt, finished: false, durationMs: 0 };
  }

  /** Queues a write of what the take recorded since the last flush, with its latest meta. */
  flush({ slides, ...update }: RecordingDraftFlush): Promise<void> {
    // A field the caller could not read this time (the recorder slices are reset once
    // the take is finalized) keeps its last written value.
    const known = Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ) as Partial<RecordingDraftMeta>;
    this.queue = this.queue.then(async () => {
      if (this.discarded || this.recordsFailed || !this.tracks) return;
      const records = this.writer.collect(this.tracks, slides);
      const meta: RecordingDraftMeta = { ...this.meta, ...known, updatedAt: Date.now() };
      try {
        await this.store.write(meta, records, this.nextSeq);
        this.meta = meta;
        this.nextSeq += records.length;
      } catch (error) {
        this.recordsFailed = true;
        console.warn("Recording draft journal stopped:", error);
      }
    });
    return this.queue;
  }

  /**
   * Lets go of the take's tracks once the writes queued so far have landed. Recorder
   * chunks that arrive later (a slow stop) are still written.
   */
  close(): void {
    this.queue = this.queue.then(() => {
      this.tracks = null;
    });
  }

  /** Queues a recorder chunk. A failed write ends that track's journal, keeping it a prefix. */
  addMedia(track: RecordingDraftMediaTrack, blob: Blob): void {
    const seq = this.mediaSeq[track]++;
    this.queue = this.queue.then(async () => {
      if (this.discarded || this.mediaFailed[track]) return;
      try {
        await this.store.appendMedia(this.id, track, seq, blob);
      } catch (error) {
        this.mediaFailed[track] = true;
        console.warn(`Recording draft ${track} journal stopped:`, error);
      }
    });
  }

  /** Stops journaling and deletes what was written, once queued writes have landed. */
  async discard(): Promise<void> {
    this.discarded = true;
    await this.queue;
    await this.store.deleteDraft(this.id);
  }
}

// ----------------------------------------------------------------------------
// Ownership and the recordings drafts belong to
// ----------------------------------------------------------------------------

const heldLocks = new Map<string, () => void>();
const journals = new Map<string, RecordingDraftJournal>();
const draftIdsByRecordingId = new Map<string, string>();
const listeners = new Set<() => void>();

const notifyDraftsChanged = () => {
  for (const listener of listeners) listener();
};

/** Called whenever this tab creates, takes over, or deletes a draft. */
export function subscribeRecordingDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks a draft as this tab's, for as long as the tab lives or until it is released. */
export function holdRecordingDraft(id: string): void {
  if (heldLocks.has(id)) return;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldLocks.set(id, release);
  // Without Web Locks this tab's own drafts are still excluded through heldLocks.
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    navigator.locks.request(`${LOCK_PREFIX}${id}`, () => held).catch(() => {});
  }
  notifyDraftsChanged();
}

function releaseRecordingDraft(id: string): void {
  heldLocks.get(id)?.();
  heldLocks.delete(id);
}

/** Drafts some open tab (this one included) still owns. */
export async function listOwnedRecordingDraftIds(): Promise<Set<string>> {
  const owned = new Set(heldLocks.keys());
  if (typeof navigator !== "undefined" && navigator.locks?.query) {
    try {
      const { held = [] } = await navigator.locks.query();
      for (const lock of held) {
        if (lock.name?.startsWith(LOCK_PREFIX)) owned.add(lock.name.slice(LOCK_PREFIX.length));
      }
    } catch {
      // A browser that refuses the query leaves other tabs' drafts looking unowned.
    }
  }
  return owned;
}

/** Starts a journal for a take this tab is recording, and takes ownership of its draft. */
export function startRecordingDraftJournal(
  tracks: RecordingTracks,
  startedAt: number,
): RecordingDraftJournal {
  const journal = new RecordingDraftJournal(tracks, startedAt);
  journals.set(journal.id, journal);
  holdRecordingDraft(journal.id);
  return journal;
}

/** Remembers which draft a recording came from: its own take, or a recovered one. */
export function linkRecordingToDraft(recordingId: string, draftId: string): void {
  draftIdsByRecordingId.set(recordingId, draftId);
}

/**
 * Deletes the draft of a recording that no longer needs one: it was uploaded or
 * exported, or its author started over. A draft this page does not know about is
 * looked up by the recording id its meta holds, which covers a take restored
 * after a sign-in redirect.
 */
export async function discardRecordingDraftFor(recordingId: string): Promise<void> {
  let draftId = draftIdsByRecordingId.get(recordingId);
  const store = getRecordingDraftStore();
  try {
    if (!draftId) {
      const metas = await store.listDrafts();
      draftId = metas.find((meta) => meta.recordingId === recordingId)?.id;
    }
    if (!draftId) return;
    draftIdsByRecordingId.delete(recordingId);
    const journal = journals.get(draftId);
    journals.delete(draftId);
    await (journal ? journal.discard() : store.deleteDraft(draftId));
  } catch (error) {
    console.warn("Could not delete the recording draft:", error);
  } finally {
    if (draftId) releaseRecordingDraft(draftId);
    notifyDraftsChanged();
  }
}

/**
 * Takes ownership of a recording's draft without recovering it: a take this page got
 * back another way (restored for an upload after a sign-in redirect) must not also be
 * offered by the recovery prompt.
 */
export async function claimRecordingDraftFor(recordingId: string): Promise<void> {
  try {
    const metas = await getRecordingDraftStore().listDrafts();
    const draftId = metas.find((meta) => meta.recordingId === recordingId)?.id;
    if (!draftId) return;
    linkRecordingToDraft(recordingId, draftId);
    holdRecordingDraft(draftId);
  } catch (error) {
    console.warn("Could not look up the recording draft:", error);
  }
}

/** Deletes a draft by id (the recovery prompt's Discard). */
export async function discardRecordingDraft(draftId: string): Promise<void> {
  const journal = journals.get(draftId);
  journals.delete(draftId);
  for (const [recordingId, linkedDraftId] of draftIdsByRecordingId) {
    if (linkedDraftId === draftId) draftIdsByRecordingId.delete(recordingId);
  }
  try {
    await (journal ? journal.discard() : getRecordingDraftStore().deleteDraft(draftId));
  } finally {
    releaseRecordingDraft(draftId);
    notifyDraftsChanged();
  }
}

export function resetRecordingDraftsForTests(): void {
  for (const release of heldLocks.values()) release();
  heldLocks.clear();
  journals.clear();
  draftIdsByRecordingId.clear();
  listeners.clear();
  resetRecordingDraftStoreForTests();
}
