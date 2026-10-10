import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, fromCallback } from "xstate";
import type * as monaco from "monaco-editor";
import type { EditorSelection, MouseCursorPosition } from "../types";
import type { TextEditEvent } from "../textEdit";
import { normalizeEditorFrame } from "../utils/editorState";
import { editorMachine } from "./editorMachine";
import { createFrame } from "./frameCapture";
import { pinPerformanceClock, selection, startTake } from "./testing/takeFixtures";

interface FakeEditorState {
  uri: string;
  /** The model instance's `id`; defaults to the uri (one model per file). */
  modelId?: string;
  versionId: number;
  value: string;
  scrollTop: number;
  position?: monaco.IPosition | null;
  selection?: monaco.ISelection | null;
  viewState?: monaco.editor.ICodeEditorViewState | null;
}

const makeEditor = (state: FakeEditorState) => {
  const getValue = vi.fn<() => string>(() => state.value);
  const saveViewState = vi.fn<() => monaco.editor.ICodeEditorViewState | null>(
    () => state.viewState ?? null,
  );
  const editor = {
    getModel: () => ({
      id: state.modelId ?? state.uri,
      getVersionId: () => state.versionId,
      uri: { toString: () => state.uri },
    }),
    getValue,
    getPosition: () => state.position ?? null,
    getSelection: () => state.selection ?? null,
    getScrollTop: () => state.scrollTop,
    getScrollLeft: () => 0,
    saveViewState,
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  return { editor, getValue, saveViewState, state };
};

const mouse: MouseCursorPosition = { x: 0, y: 0, visible: false };

/** What a capture hands the next one: its content string and view state. */
const previousOf = ({ frame, viewStateRef }: ReturnType<typeof createFrame>) => ({
  content: {
    value: frame.state.content,
    versionId: viewStateRef.versionId,
    modelId: viewStateRef.modelId,
  },
  viewState: viewStateRef,
});

describe("createFrame capture gating", () => {
  it("reuses content and viewState by reference when model, version, scroll and selection are unchanged", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
    expect(fake.saveViewState).toHaveBeenCalledTimes(1);
    expect(second.frame.state.viewState).toBe(first.frame.state.viewState);
  });

  it("does not reuse content when the model changed, even if the per-model version id coincides", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    // Simulate switching the active file: new model, same numeric version id.
    fake.state.uri = "file:///b.ts";
    fake.state.modelId = "$model2";
    fake.state.value = "bbb";

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(second.frame.state.content).toBe("bbb");
    expect(second.viewStateRef.modelId).toBe("$model2");
    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
  });

  it("does not reuse content from a removed file's model when a new model takes its uri", () => {
    const fake = makeEditor({
      uri: "file:///a.ts",
      modelId: "$model1",
      versionId: 1,
      value: "old",
      scrollTop: 0,
    });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    // The file is removed and re-created: a new model under the same uri, whose
    // version id starts over at 1.
    fake.state.modelId = "$model2";
    fake.state.value = "new";

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(fake.getValue).toHaveBeenCalledTimes(2);
    expect(second.frame.state.content).toBe("new");
    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
  });

  it("recomputes viewState when scroll changes but still reuses unchanged content", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    fake.state.scrollTop = 120;

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
  });

  it("captures a remote selection without changing the local editor cursor", () => {
    const localSelection: EditorSelection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    };
    const remoteSelection: EditorSelection = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 6,
      selectionStartLineNumber: 4,
      selectionStartColumn: 6,
      positionLineNumber: 2,
      positionColumn: 3,
    };
    const fake = makeEditor({
      uri: "file:///a.ts",
      versionId: 6,
      value: "one\ntwo\nthree\nfour",
      scrollTop: 0,
      position: { lineNumber: 1, column: 1 },
      selection: localSelection,
      viewState: {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber: 1, column: 1 },
            position: { lineNumber: 1, column: 1 },
          },
        ],
        viewState: {
          scrollTop: 0,
          scrollTopWithoutViewZones: 0,
          scrollLeft: 0,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      },
    });

    const captured = createFrame(fake.editor, {
      timestamp: 25,
      mouseCursor: mouse,
      selectionOverride: remoteSelection,
    });
    const normalized = normalizeEditorFrame(captured.frame);

    expect(normalized.state.selection).toEqual(remoteSelection);
    expect(normalized.state.position).toEqual({ lineNumber: 2, column: 3 });
    expect(
      (normalized.state.viewState as unknown as { cursorState: unknown[] }).cursorState[0],
    ).toMatchObject({
      inSelectionMode: true,
      selectionStart: { lineNumber: 4, column: 6 },
      position: { lineNumber: 2, column: 3 },
      selection: remoteSelection,
    });
    expect(fake.state.position).toEqual({ lineNumber: 1, column: 1 });
    expect(fake.state.selection).toEqual(localSelection);
  });

  it("does not rewrite the previous frame's view state when a remote selection repeats", () => {
    const remoteSelection: EditorSelection = {
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 4,
      selectionStartLineNumber: 1,
      selectionStartColumn: 2,
      positionLineNumber: 1,
      positionColumn: 4,
    };
    const fake = makeEditor({
      uri: "file:///a.ts",
      versionId: 3,
      value: "abcdef",
      scrollTop: 0,
      position: { lineNumber: 1, column: 1 },
      viewState: {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber: 1, column: 1 },
            position: { lineNumber: 1, column: 1 },
          },
        ],
        viewState: {
          scrollTop: 0,
          scrollTopWithoutViewZones: 0,
          scrollLeft: 0,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      },
    });
    const cursorStateOf = (viewState: unknown) =>
      (viewState as { cursorState: Array<Record<string, unknown>> }).cursorState;

    const first = createFrame(fake.editor, {
      timestamp: 0,
      mouseCursor: mouse,
      selectionOverride: remoteSelection,
    });
    const recordedCursor = cursorStateOf(first.frame.state.viewState)[0];
    const recordedCursorJson = JSON.stringify(recordedCursor);

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: { viewState: first.viewStateRef },
      selectionOverride: remoteSelection,
    });

    // The unchanged selection reuses the recorded view state, which must stay as recorded.
    expect(second.frame.state.viewState).toBe(first.frame.state.viewState);
    expect(cursorStateOf(first.frame.state.viewState)[0]).toBe(recordedCursor);
    expect(JSON.stringify(recordedCursor)).toBe(recordedCursorJson);
    expect(recordedCursor).toMatchObject({ inSelectionMode: true, selection: remoteSelection });
  });
});

describe("editorMachine pointer captures while recording", () => {
  // The Monaco surface createFrame reads during a take.
  class RecordingEditor {
    content = "const a = 1;";
    versionId = 1;
    uri = "file:///main.ts";
    modelCount = 1;
    getValueCalls = 0;

    getModel() {
      return {
        id: `$model${this.modelCount}`,
        uri: { toString: () => this.uri },
        getVersionId: () => this.versionId,
      } as unknown as monaco.editor.ITextModel;
    }

    getValue() {
      this.getValueCalls += 1;
      return this.content;
    }

    type(text: string) {
      this.content += text;
      this.versionId += 1;
    }

    /** Switch files: another model, which counts versions on its own from 1. */
    open(uri: string, content: string) {
      this.modelCount += 1;
      this.uri = uri;
      this.content = content;
      this.versionId = 1;
    }

    getPosition() {
      return { lineNumber: 1, column: 1 };
    }

    getSelection() {
      return selection as monaco.Selection;
    }

    getScrollTop() {
      return 0;
    }

    getScrollLeft() {
      return 0;
    }

    saveViewState() {
      return null;
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps pointer moves in the cursor track and out of the frame track", () => {
    const clock = pinPerformanceClock();
    const editor = new RecordingEditor();
    const actor = createActor(
      editorMachine.provide({ actors: { mouseTracking: fromCallback(() => {}) } }),
      {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
        },
      },
    ).start();
    actor.send({ type: "START_RECORDING" });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    const session = () => actor.getSnapshot().context.session!;
    expect(session().frames).toHaveLength(1);

    // Each move is past the 50ms frame throttle, so each one samples a full frame.
    for (const x of [100, 140]) {
      clock.now += 60;
      actor.send({
        type: "CAPTURE_FRAME",
        isMouseMovement: true,
        mousePosition: { x, y: 20, visible: true },
      });
    }

    expect(session().frames).toHaveLength(1);
    expect(session().cursorEvents.map(({ x, visible }) => ({ x, visible }))).toEqual([
      { x: 0, visible: false },
      { x: 100, visible: true },
      { x: 140, visible: true },
    ]);
    expect(session().lastMousePosition).toEqual({
      x: 140,
      y: 20,
      visible: true,
    });

    clock.now += 60;
    editor.type("!");
    actor.send({ type: "CAPTURE_FRAME" });

    expect(session().frames).toHaveLength(2);
    expect(session().frames[1]).toMatchObject({
      isKeyframe: false,
      mouseCursor: { x: 140, y: 20, visible: true },
    });
    actor.stop();
  });

  it("reuses the captured content until the model changes", () => {
    const clock = pinPerformanceClock();
    const editor = new RecordingEditor();
    const actor = startTake(editor);
    const reads = editor.getValueCalls;

    const capturedContent = () => actor.getSnapshot().context.session!.lastCapturedContent;

    clock.now += 60;
    actor.send({ type: "CAPTURE_FRAME" });
    expect(editor.getValueCalls).toBe(reads);
    expect(capturedContent()?.value).toBe("const a = 1;");

    clock.now += 60;
    editor.type("!");
    actor.send({ type: "CAPTURE_FRAME" });
    expect(editor.getValueCalls).toBe(reads + 1);
    expect(capturedContent()?.value).toBe("const a = 1;!");
    actor.stop();
  });

  it("reads the new file after a switch that lands on the same version id", () => {
    const clock = pinPerformanceClock();
    const editor = new RecordingEditor();
    const actor = startTake(editor);

    clock.now += 60;
    editor.open("file:///other.ts", "let b = 2;");
    actor.send({ type: "CAPTURE_FRAME" });

    expect(actor.getSnapshot().context.session!.lastCapturedContent?.value).toBe("let b = 2;");
    expect(actor.getSnapshot().context.session!.frames).toHaveLength(2);
    actor.stop();
  });

  /** The edit `editor.type(text)` makes, as the host reports it with CAPTURE_FRAME. */
  const typeWithEdit = (editor: RecordingEditor, text: string): TextEditEvent => {
    const beforeLength = editor.content.length;
    const beforeVersion = editor.versionId;
    editor.type(text);
    return {
      fileId: "main",
      path: "/main.ts",
      beforeVersion,
      afterVersion: editor.versionId,
      beforeLength,
      afterLength: editor.content.length,
      changes: [{ offset: beforeLength, deleteLength: 0, text }],
    };
  };

  // The reuse base lives on the session. It used to be read back through currentFrame,
  // which the root SET_EDITOR_REF handler clears for the replay, so an editor remount
  // mid-take cost the next capture its exact edit and a full read of the file.
  it("keeps the exact edit across SET_EDITOR_REF mid-take", () => {
    const clock = pinPerformanceClock();
    const editor = new RecordingEditor();
    const actor = startTake(editor);
    const reads = editor.getValueCalls;

    actor.send({
      type: "SET_EDITOR_REF",
      editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
    });
    clock.now += 60;
    actor.send({ type: "CAPTURE_FRAME", textEdit: typeWithEdit(editor, "!") });

    const frames = actor.getSnapshot().context.session!.frames;
    expect(frames).toHaveLength(2);
    expect(frames[1]).toHaveProperty("contentEditDelta");
    expect(frames[1]).not.toHaveProperty("contentDelta");
    expect(editor.getValueCalls).toBe(reads);
    actor.stop();
  });

  it("records the same frames whether or not the editor is remounted mid-take", () => {
    const clock = pinPerformanceClock();
    const recordTake = (remount: boolean) => {
      clock.now = 1_000;
      const editor = new RecordingEditor();
      const actor = startTake(editor);
      const remountWith = (next: RecordingEditor) => {
        if (!remount) return;
        actor.send({
          type: "SET_EDITOR_REF",
          editor: next as unknown as monaco.editor.IStandaloneCodeEditor,
        });
      };

      remountWith(editor);
      clock.now += 60;
      actor.send({ type: "CAPTURE_FRAME", textEdit: typeWithEdit(editor, "!") });
      // A new editor instance on the same model, as a remount gives.
      const remounted = Object.assign(new RecordingEditor(), {
        content: editor.content,
        versionId: editor.versionId,
      });
      remountWith(remounted);
      const live = remount ? remounted : editor;
      clock.now += 60;
      actor.send({ type: "CAPTURE_FRAME", textEdit: typeWithEdit(live, "?") });
      clock.now += 60;
      actor.send({
        type: "CAPTURE_FRAME",
        isMouseMovement: true,
        mousePosition: { x: 10, y: 20, visible: true },
      });
      clock.now += 60;
      actor.send({ type: "CAPTURE_FRAME" });

      const frames = actor.getSnapshot().context.session!.frames;
      actor.stop();
      return frames;
    };

    const frames = recordTake(false);
    expect(frames.filter((frame) => "contentEditDelta" in frame)).toHaveLength(2);
    expect(recordTake(true)).toEqual(frames);
  });

  // capturePreviewEvent is a plain action and capturePreviewRefreshFrame follows it in
  // the same transition: the event lands in its track before the frame is committed.
  it("records a preview refresh as an event and then a frame carrying its page", () => {
    const clock = pinPerformanceClock();
    const editor = new RecordingEditor();
    const actor = createActor(
      editorMachine.provide({ actors: { mouseTracking: fromCallback(() => {}) } }),
      {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          getPreviewState: () => ({ isOpen: true, size: "small", content: "<p>before</p>" }),
        },
      },
    ).start();
    actor.send({ type: "START_RECORDING" });
    const session = () => actor.getSnapshot().context.session!;
    const previewEventCount = session().previewEvents.length;
    const frameCount = session().frames.length;

    clock.now += 60;
    actor.send({
      type: "PREVIEW_EVENT",
      event: { type: "preview_refresh", timestamp: 0, content: "<p>after</p>" },
    });

    expect(session().previewEvents).toHaveLength(previewEventCount + 1);
    expect(session().previewEvents.at(-1)).toMatchObject({
      type: "preview_refresh",
      content: "<p>after</p>",
    });
    expect(session().frames).toHaveLength(frameCount + 1);
    expect(session().encoder.lastFullFrame?.state.previewState?.content).toBe("<p>after</p>");
    actor.stop();
  });
});
