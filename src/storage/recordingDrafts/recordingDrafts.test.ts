// @vitest-environment node
// (fake-indexeddb stores Blobs with the global structuredClone, which under jsdom
// cannot clone jsdom's Blob; see src/test/fakeIndexedDB.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeIndexedDB } from "../../test/fakeIndexedDB";
import { createEmptyRecordingTracks } from "../../core/src/machine/recordingAssembly";
import { compressFrames } from "../../core/src/utils/frameStreamEncoder";
import type { EditorFrame } from "../../core/src/types";
import {
  getRecordingDraftStore,
  RecordingDraftStore,
  type RecordingDraftRecord,
} from "./recordingDraftStore";
import {
  claimRecordingDraftFor,
  discardRecordingDraftFor,
  holdRecordingDraft,
  linkRecordingToDraft,
  listOwnedRecordingDraftIds,
  RecordingDraftJournal,
  resetRecordingDraftsForTests,
  startRecordingDraftJournal,
} from "./recordingDraftJournal";
import { recoverRecordingDraft } from "./recoverRecordingDraft";

const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

const frame = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: {
    content,
    selection,
    position: { lineNumber: 1, column: 1 },
    viewState: null,
    mouseCursor: { x: 0, y: 0, visible: false },
  },
});

let fake: FakeIndexedDB;

beforeEach(() => {
  resetRecordingDraftsForTests();
  fake = new FakeIndexedDB();
  vi.stubGlobal("indexedDB", fake.indexedDB);
  vi.stubGlobal("IDBKeyRange", fake.IDBKeyRange);
  // No Web Locks by default: ownership is then this page's own bookkeeping, which the
  // tests can read back without waiting on lock releases.
  vi.stubGlobal("navigator", {});
});

afterEach(() => {
  resetRecordingDraftsForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RecordingDraftStore", () => {
  it("keeps each draft's records and media apart and in order", async () => {
    const store = new RecordingDraftStore();
    const meta = (id: string, startedAt: number) => ({
      id,
      startedAt,
      updatedAt: startedAt,
      finished: false,
      durationMs: 0,
    });
    await store.write(meta("a", 1), [{ kind: "append", track: "frames", entries: [1] }], 0);
    await store.write(meta("b", 2), [{ kind: "append", track: "frames", entries: [9] }], 0);
    await store.write(meta("a", 1), [{ kind: "append", track: "frames", entries: [2] }], 1);
    await store.appendMedia("a", "audio", 1, new Blob(["second"]));
    await store.appendMedia("a", "audio", 0, new Blob(["first"]));
    await store.appendMedia("a", "camera", 0, new Blob(["video"]));

    const draft = await store.readDraft("a");
    expect(draft?.records).toEqual([
      { kind: "append", track: "frames", entries: [1] },
      { kind: "append", track: "frames", entries: [2] },
    ]);
    expect(await Promise.all(draft!.media.audio.map((blob) => blob.text()))).toEqual([
      "first",
      "second",
    ]);
    expect(draft?.media.camera).toHaveLength(1);
    // Newest first.
    expect((await store.listDrafts()).map((listed) => listed.id)).toEqual(["b", "a"]);

    await store.deleteDraft("a");
    expect(await store.readDraft("a")).toBeNull();
    expect((await store.readDraft("b"))?.records).toHaveLength(1);
  });

  it("opens the database again after a failed open, so later writes still journal", async () => {
    // A newer build left the drafts database at v2, so this build's v1 open fails.
    await fake.seed("next-editor-recording-drafts", 2, {});
    const store = getRecordingDraftStore();
    const meta = { id: "a", startedAt: 1, updatedAt: 1, finished: false, durationMs: 0 };
    const record: RecordingDraftRecord = { kind: "append", track: "frames", entries: [1] };

    await expect(store.write(meta, [record], 0)).rejects.toMatchObject({ name: "VersionError" });

    await new Promise<void>((resolve, reject) => {
      const request = fake.indexedDB.deleteDatabase("next-editor-recording-drafts");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await store.write(meta, [record], 0);
    expect((await store.readDraft("a"))?.records).toEqual([record]);
    expect((await store.listDrafts()).map((listed) => listed.id)).toEqual(["a"]);
  });
});

describe("recovering a take from its draft", () => {
  it("rebuilds the recording the take would have become, audio included", async () => {
    const tracks = createEmptyRecordingTracks();
    const journal = new RecordingDraftJournal(tracks, 1_000, getRecordingDraftStore());

    tracks.frames.push(...compressFrames([frame(0, "a"), frame(400, "ab")]));
    tracks.cursorEvents.push({ timestamp: 0, x: 0, y: 0, visible: false });
    await journal.flush({
      durationMs: 500,
      audio: { mimeType: "audio/webm", source: "microphone" },
    });
    journal.addMedia("audio", new Blob(["chunk-1"]));

    tracks.frames.push(...compressFrames([frame(900, "abc")]).map((entry) => ({ ...entry })));
    journal.addMedia("audio", new Blob(["chunk-2"]));
    // A flush that could not read the recorder slice keeps the audio it wrote before.
    await journal.flush({ durationMs: 1_200, finished: true, recordingId: "take-1" });

    const recording = await recoverRecordingDraft(journal.id);
    expect(recording).not.toBeNull();
    expect(recording!.id).toBe("take-1");
    expect(recording!.frames).toHaveLength(3);
    expect(recording!.duration).toBe(1_200);
    expect(recording!.audioSource).toBe("microphone");
    expect(recording!.audioBlob?.type).toBe("audio/webm");
    expect(await recording!.audioBlob?.text()).toBe("chunk-1chunk-2");
    expect(recording!.streamFinalized).toBe(true);
  });

  it("carries a retaken take's cuts, to cut the narration when it loads", async () => {
    const tracks = createEmptyRecordingTracks();
    const journal = new RecordingDraftJournal(tracks, 1_000);
    tracks.frames.push(...compressFrames([frame(0, "a")]));
    journal.addMedia("audio", new Blob(["chunk"]));
    await journal.flush({
      durationMs: 500,
      audio: { mimeType: "audio/webm", source: "microphone" },
      mediaCuts: [{ start: 100, end: 900 }],
    });

    const recording = await recoverRecordingDraft(journal.id);
    expect(recording?.pendingAudioEdit).toEqual({ cuts: [{ start: 100, end: 900 }] });
  });

  it("offers nothing for a draft whose tab closed before its first frame was written", async () => {
    const journal = new RecordingDraftJournal(createEmptyRecordingTracks(), 1_000);
    await journal.flush({ durationMs: 0 });
    expect(await recoverRecordingDraft(journal.id)).toBeNull();
  });

  it("stops journaling after a failed write, so the draft stays a prefix of the take", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracks = createEmptyRecordingTracks();
    const journal = new RecordingDraftJournal(tracks, 1_000);
    tracks.frames.push(...compressFrames([frame(0, "a")]));
    await journal.flush({ durationMs: 100 });

    fake.failNextCommit(new DOMException("disk full", "QuotaExceededError"));
    tracks.cursorEvents.push({ timestamp: 200, x: 1, y: 1, visible: true });
    await journal.flush({ durationMs: 200 });
    tracks.cursorEvents.push({ timestamp: 300, x: 2, y: 2, visible: true });
    await journal.flush({ durationMs: 300 });

    const recording = await recoverRecordingDraft(journal.id);
    expect(recording?.duration).toBe(100);
    expect(recording?.cursorEvents).toEqual([]);
  });
});

describe("draft ownership", () => {
  it("treats this tab's drafts as owned until they are discarded", async () => {
    const tracks = createEmptyRecordingTracks();
    const journal = startRecordingDraftJournal(tracks, 1_000);
    tracks.frames.push(...compressFrames([frame(0, "a")]));
    await journal.flush({ durationMs: 10, finished: true, recordingId: "take-1" });
    linkRecordingToDraft("take-1", journal.id);

    expect(await listOwnedRecordingDraftIds()).toContain(journal.id);

    await discardRecordingDraftFor("take-1");
    expect(await listOwnedRecordingDraftIds()).not.toContain(journal.id);
    expect(await getRecordingDraftStore().listDrafts()).toEqual([]);
  });

  it("finds a recording's draft by the id its meta holds, as after a reload", async () => {
    const tracks = createEmptyRecordingTracks();
    const journal = new RecordingDraftJournal(tracks, 1_000);
    tracks.frames.push(...compressFrames([frame(0, "a")]));
    await journal.flush({ durationMs: 10, finished: true, recordingId: "take-2" });

    await claimRecordingDraftFor("take-2");
    expect(await listOwnedRecordingDraftIds()).toContain(journal.id);

    await discardRecordingDraftFor("take-2");
    expect(await getRecordingDraftStore().readDraft(journal.id)).toBeNull();
  });

  it("leaves another tab's lock alone", async () => {
    holdRecordingDraft("draft-held-here");
    const locks = {
      request: vi.fn<LockManager["request"]>(() => Promise.resolve()),
      query: vi.fn<LockManager["query"]>(() =>
        Promise.resolve({
          held: [{ name: "next-editor-recording-draft:draft-other-tab", mode: "exclusive" }],
          pending: [],
        } as LockManagerSnapshot),
      ),
    };
    vi.stubGlobal("navigator", { locks });
    expect(await listOwnedRecordingDraftIds()).toEqual(
      new Set(["draft-held-here", "draft-other-tab"]),
    );
  });
});
