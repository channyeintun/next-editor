import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createActor } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./machine/editorMachine";
import {
  useNextEditorActorActions,
  useNextEditorInteractionEffects,
  type EditorActorRef,
} from "./useNextEditor";

// Guardrails from 0831171 / f280e83: a recording once captured a single empty frame
// because the machine lost its editor reference. These tests pin the three defences.

type EditorRef = { current: monaco.editor.IStandaloneCodeEditor | null };

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

// Just enough of a Monaco editor for createFrame and the interaction listeners.
const createMockEditor = (content: string) => {
  const model = { uri: { toString: () => "file:///main.ts" }, getVersionId: () => 1 };
  const disposable = { dispose: () => {} };
  return {
    getModel: () => model,
    getValue: () => content,
    getSelection: () => selection,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getScrollTop: () => 0,
    getScrollLeft: () => 0,
    saveViewState: () => null,
    hasTextFocus: () => true,
    onKeyDown: () => disposable,
    onDidPaste: () => disposable,
  } as unknown as monaco.editor.IStandaloneCodeEditor;
};

const actors: EditorActorRef[] = [];
const startActor = (editorRef: EditorRef) => {
  const actor = createActor(editorMachine, { input: { editorRef } }).start();
  actors.push(actor);
  return actor;
};

afterEach(() => {
  actors.splice(0).forEach((actor) => actor.stop());
});

describe("useNextEditorActorActions", () => {
  // The React Compiler skips hookless hooks, and CodeEditor keys an unmount cleanup
  // (which detaches the editor from the machine) on syncEditorRef, so the senders'
  // identities must be held explicitly.
  it("keeps sender identities across renders and renews them for a new actor", () => {
    const first = startActor({ current: null });
    const { result, rerender } = renderHook(({ actor }) => useNextEditorActorActions(actor), {
      initialProps: { actor: first },
    });
    const initialSync = result.current.syncEditorRef;

    rerender({ actor: first });
    expect(result.current.syncEditorRef).toBe(initialSync);

    rerender({ actor: startActor({ current: null }) });
    expect(result.current.syncEditorRef).not.toBe(initialSync);
  });
});

describe("useNextEditorInteractionEffects", () => {
  // A SET_EDITOR_REF sent while the actor is stopped is dropped, so the hook
  // re-asserts the ref after every transition rather than only on mount.
  it("re-sends a stale editor ref after a machine transition", () => {
    const editorRef: EditorRef = { current: null };
    const actor = startActor(editorRef);
    renderHook(() => useNextEditorInteractionEffects(actor, { editorRef }));

    const editor = createMockEditor("const a = 1;");
    editorRef.current = editor;
    expect(actor.getSnapshot().context.editorRefs.editor).toBeNull();

    actor.send({ type: "START_RECORDING" });

    expect(actor.getSnapshot().matches("recording")).toBe(true);
    expect(actor.getSnapshot().context.editorRefs.editor).toBe(editor);
  });
});

describe("capture editor fallback", () => {
  // createInitialContext seeds editorRefs.editor from the ref at creation, so the ref
  // must be empty then and filled afterwards, with no SET_EDITOR_REF, to reach the
  // `editorRefs.editor ?? getEditorInstance()` fallback.
  it("captures from the input ref when the context editor was never set", () => {
    const editorRef: EditorRef = { current: null };
    const actor = startActor(editorRef);
    editorRef.current = createMockEditor("const captured = true;");

    actor.send({ type: "START_RECORDING" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches("recording")).toBe(true);
    expect(snapshot.context.editorRefs.editor).toBeNull();
    expect(snapshot.context.currentFrame?.state.content).toBe("const captured = true;");
  });
});
