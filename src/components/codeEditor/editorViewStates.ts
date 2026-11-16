import { isPlaybackModelUri, monaco, workspaceModelUriFromPlaybackModelUri } from "../../monaco";

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;
type TextModel = monaco.editor.ITextModel;
type ViewState = monaco.editor.ICodeEditorViewState;

/**
 * The caret, selection and scroll each file is shown with. Monaco keeps them per
 * editor, not per model, and starts every model it is given at the top with the caret
 * on line 1, so they are saved as the editor leaves a model and restored as it comes
 * back.
 *
 * A lesson replays into a playback model of the open file and hands the file itself
 * to the viewer when it pauses or ends. That swap continues one view, not two: the
 * caret the viewer placed while the lesson played, and the scroll they were looking
 * at, move over to the file, so what they type lands where their caret was. Without
 * that the first keystroke, which is what pauses the lesson, went in at the start of
 * line 1.
 */
export interface EditorViewStates {
  /** Call while `editor` still shows the model it is about to swap for another. */
  save(editor: StandaloneEditor | null): void;
  /**
   * Call before `editor` is disposed. A file's view is kept for the next editor; a
   * lesson's is not handed over, since no swap follows: whichever editor next shows
   * that file, in this lesson or the next, would open on a view from another time.
   */
  saveBeforeDispose(editor: StandaloneEditor | null): void;
  /** Call once `editor` shows `model`. */
  restore(editor: StandaloneEditor, model: TextModel | null): void;
  /** Drops what was saved for the model at `uri` (its file left the project). */
  forget(uri: string): void;
}

export function createEditorViewStates(): EditorViewStates {
  const savedByUri = new Map<string, ViewState | null>();
  // The view on a playback model as the editor left it, for the workspace model of
  // the same file (named by its URI) if that is what the editor shows next.
  let handedOver: { workspaceUri: string; viewState: ViewState | null } | null = null;

  const save: EditorViewStates["save"] = (editor) => {
    const model = editor?.getModel();
    if (!editor || !model) return;

    const workspaceUri = workspaceModelUriFromPlaybackModelUri(monaco, model.uri);
    if (workspaceUri !== null) {
      // Replay rebuilds a playback model's view from the recording, so it is kept
      // only for the hand-over.
      handedOver = { workspaceUri, viewState: editor.saveViewState() };
      return;
    }

    savedByUri.set(model.uri.toString(), editor.saveViewState());
  };

  return {
    save,

    saveBeforeDispose(editor) {
      save(editor);
      handedOver = null;
    },

    restore(editor, model) {
      const lastPlaybackView = handedOver;
      handedOver = null;
      if (!model || isPlaybackModelUri(model.uri)) return;

      const modelUri = model.uri.toString();
      const viewState =
        lastPlaybackView?.workspaceUri === modelUri
          ? lastPlaybackView.viewState
          : savedByUri.get(modelUri);

      if (viewState) {
        editor.restoreViewState(viewState);
      }
    },

    forget(uri) {
      savedByUri.delete(uri);
    },
  };
}
