import { useEffect, useState } from "react";
import { importWithChunkRecovery } from "../routeRecovery";
import { getLoadedCodeEditor, loadCodeEditor, type CodeEditorComponent } from "./codeEditorLoader";

/** Keys CodeEditor's one automatic stale-chunk reload (see routeRecovery). */
export const CODE_EDITOR_CHUNK = "CodeEditor";

/**
 * CodeEditor for Editor to render once its chunk has loaded, or null while it
 * loads, when Editor shows its skeleton instead. The component arrives through
 * a state update, which React commits as soon as it has rendered. React.lazy
 * revealed it through a Suspense retry, which React holds back until 300 ms
 * after the fallback appeared, so on a fast device the code painted up to that
 * much later than Monaco was ready. `failed` is set when the import failed and
 * stale-chunk recovery did not reload the page: Editor then renders its lazy
 * CodeEditor, whose own import reports the failure as before.
 */
export function useCodeEditorComponent(): {
  CodeEditor: CodeEditorComponent | null;
  failed: boolean;
} {
  const [CodeEditor, setCodeEditor] = useState(getLoadedCodeEditor);
  const [failed, setFailed] = useState(false);

  // Also when the chunk is already in: the import's success re-arms the
  // automatic reload, as React.lazy's first render did.
  useEffect(() => {
    let active = true;
    importWithChunkRecovery(loadCodeEditor, CODE_EDITOR_CHUNK).then(
      (module) => {
        if (active) setCodeEditor(() => module.default);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return { CodeEditor, failed };
}
