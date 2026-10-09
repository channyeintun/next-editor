import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, fromCallback } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "../core/src/machine/editorMachine";
import { createEmptyRecordingTracks } from "../core/src/machine/recordingAssembly";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import type { Recording } from "../core/src/types";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import RecordingDraftRecovery from "../components/RecordingDraftRecovery";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import { getRecordingDraftStore } from "../storage/recordingDrafts/recordingDraftStore";
import {
  RecordingDraftJournal,
  resetRecordingDraftsForTests,
} from "../storage/recordingDrafts/recordingDraftJournal";
import { recoverRecordingDraft } from "../storage/recordingDrafts/recoverRecordingDraft";
import { useRecordingDraftJournal } from "./useRecordingDraftJournal";

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

class RecordingEditor {
  content = "let a = 1;";
  versionId = 1;
  readonly model = {
    uri: { toString: () => "file:///main.ts" },
    getVersionId: () => this.versionId,
  };
  getModel = () => this.model as unknown as monaco.editor.ITextModel;
  getValue = () => this.content;
  getPosition = () => ({ lineNumber: 1, column: 1 });
  getSelection = () => selection as monaco.Selection;
  getScrollTop = () => 0;
  getScrollLeft = () => 0;
  saveViewState = () => null;
  type(text: string) {
    this.content += text;
    this.versionId += 1;
  }
}

beforeEach(() => {
  resetRecordingDraftsForTests();
  const fake = new FakeIndexedDB();
  vi.stubGlobal("indexedDB", fake.indexedDB);
  vi.stubGlobal("IDBKeyRange", fake.IDBKeyRange);
});

afterEach(() => {
  resetRecordingDraftsForTests();
  vi.unstubAllGlobals();
});

describe("useRecordingDraftJournal", () => {
  it("journals a take as it records and ties the draft to the finished recording", async () => {
    const editor = new RecordingEditor();
    const actor = createActor(
      editorMachine.provide({ actors: { mouseTracking: fromCallback(() => {}) } }),
      {
        input: { editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor } },
      },
    ).start();
    renderHook(() => useRecordingDraftJournal(actor, true));

    act(() => {
      actor.send({ type: "START_RECORDING" });
    });
    await waitFor(async () =>
      expect(await getRecordingDraftStore().listDrafts()).toMatchObject([{ finished: false }]),
    );

    editor.type("!");
    act(() => {
      actor.send({ type: "CAPTURE_FRAME" });
      actor.send({ type: "STOP_RECORDING" });
    });
    await waitFor(() => expect(actor.getSnapshot().context.recording).not.toBeNull());
    const recording = actor.getSnapshot().context.recording!;

    await waitFor(async () =>
      expect(await getRecordingDraftStore().listDrafts()).toMatchObject([
        { finished: true, recordingId: recording.id },
      ]),
    );
    const [draft] = await getRecordingDraftStore().listDrafts();
    const recovered = await recoverRecordingDraft(draft.id);
    expect(recovered?.id).toBe(recording.id);
    expect(recovered?.frames).toHaveLength(recording.frames.length);
    actor.stop();
  });

  it("journals nothing when turned off", async () => {
    const actor = createActor(
      editorMachine.provide({ actors: { mouseTracking: fromCallback(() => {}) } }),
      { input: { editorRef: { current: null } } },
    ).start();
    renderHook(() => useRecordingDraftJournal(actor, false));
    act(() => {
      actor.send({ type: "START_RECORDING" });
    });
    // Give a journal every chance to have written.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await getRecordingDraftStore().listDrafts()).toEqual([]);
    actor.stop();
  });
});

describe("RecordingDraftRecovery", () => {
  /** A finished take in a draft no open tab owns; `empty` leaves it without a frame. */
  async function seedOrphanedDraft(recordingId: string, { empty = false } = {}): Promise<string> {
    const tracks = createEmptyRecordingTracks();
    if (!empty) {
      tracks.frames.push(
        ...compressFrames([
          {
            timestamp: 0,
            state: {
              content: "hi",
              selection,
              position: { lineNumber: 1, column: 1 },
              viewState: null,
            },
          },
        ]),
      );
    }
    const journal = new RecordingDraftJournal(tracks, Date.now());
    await journal.flush({ durationMs: 65_000, finished: true, recordingId });
    return journal.id;
  }

  const renderRecovery = (onRecovered: (recording: Recording) => void) =>
    render(
      <NextEditorActorContext.Provider options={{ input: { editorRef: { current: null } } }}>
        <RecordingDraftRecovery onRecovered={onRecovered} />
      </NextEditorActorContext.Provider>,
    );

  it("offers an orphaned take back and hands it over on Recover", async () => {
    await seedOrphanedDraft("take-7");
    const onRecovered = vi.fn<(recording: Recording) => void>();
    renderRecovery(onRecovered);

    expect(await screen.findByText("Unsaved recording")).toBeInTheDocument();
    expect(screen.getByText(/1:05/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));

    await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1));
    expect(onRecovered.mock.calls[0][0].id).toBe("take-7");
    // The draft is this page's now, so the prompt steps aside.
    await waitFor(() => expect(screen.queryByText("Unsaved recording")).not.toBeInTheDocument());
  });

  it("deletes a take only after Discard is confirmed", async () => {
    const draftId = await seedOrphanedDraft("take-8");
    renderRecovery(vi.fn<(recording: Recording) => void>());

    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await getRecordingDraftStore().readDraft(draftId)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Unsaved recording")).not.toBeInTheDocument());
    expect(await getRecordingDraftStore().readDraft(draftId)).toBeNull();
  });

  it("keeps focus on the prompt as Discard and Keep swap its buttons", async () => {
    await seedOrphanedDraft("take-9");
    renderRecovery(vi.fn<(recording: Recording) => void>());

    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus();
  });

  it("announces a take with nothing to play and offers to delete it", async () => {
    await seedOrphanedDraft("take-10", { empty: true });
    const onRecovered = vi.fn<(recording: Recording) => void>();
    renderRecovery(onRecovered);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing in this recording could be played back.",
    );
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    expect(onRecovered).not.toHaveBeenCalled();
  });
});
