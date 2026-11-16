import { describe, expect, it, vi } from "vite-plus/test";
// The monaco-editor package is mocked under test (vite.config.ts), so take Monaco's real
// URI class from its file: models are matched by the URI Monaco serialises.
// @ts-expect-error -- Monaco publishes no types for its internal modules.
import { URI } from "../../../node_modules/monaco-editor/esm/vs/base/common/uri.js";
import type { monaco } from "../../monaco";
import { toMonacoModelPath, toPlaybackModelPath } from "../../monaco/models";

// Only the model-path rules and Monaco's URI are needed, not the Monaco runtime the
// package's index sets up.
vi.mock("../../monaco", async () => ({
  ...(await import("../../monaco/models")),
  monaco: { Uri: URI },
}));

const { createEditorViewStates } = await import("./editorViewStates");

type ViewState = monaco.editor.ICodeEditorViewState;
type Model = { uri: { toString(): string } };

// Models carry the URI Monaco parsed their path into, as real ones do.
const workspaceModel = (path: string): Model => ({ uri: URI.parse(toMonacoModelPath(path)) });
const playbackModel = (path: string): Model => ({ uri: URI.parse(toPlaybackModelPath(path)) });

/** A view with the caret on `line`, enough to tell one saved view from another. */
const viewOn = (line: number) =>
  ({
    cursorState: [
      {
        inSelectionMode: false,
        selectionStart: { lineNumber: line, column: 1 },
        position: { lineNumber: line, column: 1 },
      },
    ],
  }) as ViewState;

/**
 * An editor that shows one model with one view, and starts every model it is given
 * with no view of its own, as Monaco does (the caret on line 1, scrolled to the top).
 */
function fakeEditor(model: Model, view: ViewState | null = null) {
  const state = { model, view };
  const restoreViewState = vi.fn<(next: ViewState) => void>((next) => {
    state.view = next;
  });
  return {
    editor: {
      getModel: () => state.model,
      saveViewState: () => state.view,
      restoreViewState,
    } as unknown as monaco.editor.IStandaloneCodeEditor,
    restoreViewState,
    view: () => state.view,
    /** The learner moves the caret or scrolls. */
    look(next: ViewState) {
      state.view = next;
    },
    /** Swaps models the way MonacoEditor does: save, set the model, restore. */
    show(viewStates: ReturnType<typeof createEditorViewStates>, next: Model) {
      viewStates.save(this.editor);
      state.model = next;
      state.view = null;
      viewStates.restore(this.editor, next as unknown as monaco.editor.ITextModel);
    },
  };
}

describe("editor view states", () => {
  // The reported bug: a learner clicked into the code while a lesson played and
  // typed. The first key pauses the lesson, which swaps the playback model for the
  // file's own, and the new model started with its caret on line 1.
  it("hands the view on a lesson's playback model to the file the lesson hands over", () => {
    const viewStates = createEditorViewStates();
    const fake = fakeEditor(playbackModel("src/App.tsx"), viewOn(20));

    fake.show(viewStates, workspaceModel("src/App.tsx"));

    expect(fake.view()).toEqual(viewOn(20));
  });

  // Monaco rewrites some file URIs (a leading `X:` becomes a lowercase drive letter),
  // so the two models are matched by URI, not by a path decoded from each.
  it.each(["X:notes.md", "src/routes/posts/$postId.tsx", "notes;v2 & more=1,2.md", "ü/😀.md"])(
    "hands the view over for a file named %s",
    (path) => {
      const viewStates = createEditorViewStates();
      const fake = fakeEditor(playbackModel(path), viewOn(20));

      fake.show(viewStates, workspaceModel(path));

      expect(fake.view()).toEqual(viewOn(20));
    },
  );

  it("prefers the view just handed over to the one saved at the previous pause", () => {
    const viewStates = createEditorViewStates();
    const fake = fakeEditor(workspaceModel("src/App.tsx"), viewOn(5));

    // Play: the editor leaves the file at line 5 for its playback model.
    fake.show(viewStates, playbackModel("src/App.tsx"));
    expect(fake.restoreViewState).not.toHaveBeenCalled();

    // The lesson moves on and the learner clicks on line 20, then pauses.
    fake.look(viewOn(20));
    fake.show(viewStates, workspaceModel("src/App.tsx"));

    expect(fake.view()).toEqual(viewOn(20));
  });

  it("keeps a file's own view when the lesson handed over another file", () => {
    const viewStates = createEditorViewStates();
    const fake = fakeEditor(workspaceModel("src/other.ts"), viewOn(7));
    fake.show(viewStates, playbackModel("src/App.tsx"));
    fake.look(viewOn(20));

    // The learner opened src/other.ts in the sidebar, which also pauses the lesson.
    fake.show(viewStates, workspaceModel("src/other.ts"));

    expect(fake.view()).toEqual(viewOn(7));
  });

  it("hands a playback view over once", () => {
    const viewStates = createEditorViewStates();
    const fake = fakeEditor(playbackModel("src/App.tsx"), viewOn(20));
    fake.show(viewStates, workspaceModel("src/App.tsx"));

    // While paused the learner moves to line 9, visits another file and comes back.
    fake.look(viewOn(9));
    fake.show(viewStates, workspaceModel("src/other.ts"));
    fake.show(viewStates, workspaceModel("src/App.tsx"));

    expect(fake.view()).toEqual(viewOn(9));
  });

  // The recording opens an image, so the editor is disposed while it shows a playback
  // model. No swap follows: the editor that next shows that file, perhaps in the next
  // lesson, must not open on where this lesson's recording had left it.
  it("does not hand over the view of a playback model the editor was disposed on", () => {
    const viewStates = createEditorViewStates();
    const disposed = fakeEditor(playbackModel("src/App.tsx"), viewOn(80));
    viewStates.saveBeforeDispose(disposed.editor);

    const mounted = fakeEditor(workspaceModel("src/App.tsx"));
    viewStates.restore(
      mounted.editor,
      workspaceModel("src/App.tsx") as unknown as monaco.editor.ITextModel,
    );

    expect(mounted.restoreViewState).not.toHaveBeenCalled();
  });

  it("keeps a file's own view across the editor being disposed", () => {
    const viewStates = createEditorViewStates();
    const disposed = fakeEditor(workspaceModel("src/App.tsx"), viewOn(12));
    viewStates.saveBeforeDispose(disposed.editor);

    const mounted = fakeEditor(workspaceModel("src/App.tsx"));
    viewStates.restore(
      mounted.editor,
      workspaceModel("src/App.tsx") as unknown as monaco.editor.ITextModel,
    );

    expect(mounted.view()).toEqual(viewOn(12));
  });

  it("forgets the view of a file that left the project", () => {
    const viewStates = createEditorViewStates();
    const fake = fakeEditor(workspaceModel("src/App.tsx"), viewOn(5));
    fake.show(viewStates, workspaceModel("src/other.ts"));

    viewStates.forget(workspaceModel("src/App.tsx").uri.toString());
    fake.show(viewStates, workspaceModel("src/App.tsx"));

    expect(fake.view()).toBeNull();
  });
});
