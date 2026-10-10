type CodeEditorModule = typeof import("./CodeEditor");

let codeEditorPromise: Promise<CodeEditorModule> | null = null;

/**
 * Share one import of CodeEditor, and Monaco with it, between React.lazy and
 * whoever waits for the editor chunk. A failed import is forgotten, so the
 * next call fetches it again instead of repeating the old failure.
 */
export function loadCodeEditor(): Promise<CodeEditorModule> {
  codeEditorPromise ??= import("./CodeEditor").catch((error: unknown) => {
    codeEditorPromise = null;
    throw error;
  });
  return codeEditorPromise;
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
