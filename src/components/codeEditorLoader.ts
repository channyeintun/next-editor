type CodeEditorModule = typeof import("./CodeEditor");
export type CodeEditorComponent = CodeEditorModule["default"];

let codeEditorPromise: Promise<CodeEditorModule> | null = null;
let loadedCodeEditor: CodeEditorComponent | null = null;

/**
 * Share one import of CodeEditor, and Monaco with it, between the routes that
 * prefetch it, Editor, and whoever waits for the editor chunk. A failed import
 * is forgotten, so the next call fetches it again instead of repeating the old
 * failure.
 */
export function loadCodeEditor(): Promise<CodeEditorModule> {
  codeEditorPromise ??= import("./CodeEditor").then(
    (module) => {
      loadedCodeEditor = module.default;
      return module;
    },
    (error: unknown) => {
      codeEditorPromise = null;
      throw error;
    },
  );
  return codeEditorPromise;
}

/** CodeEditor once loadCodeEditor has loaded it, so a later Editor can render it at once. */
export function getLoadedCodeEditor(): CodeEditorComponent | null {
  return loadedCodeEditor;
}

/**
 * Settles once the CodeEditor chunk has loaded, or has failed to: from then on
 * Monaco no longer competes with other downloads for the network. Starts the
 * import when nothing has yet.
 */
export function whenCodeEditorLoaded(): Promise<void> {
  return loadCodeEditor().then(
    () => {},
    () => {},
  );
}
