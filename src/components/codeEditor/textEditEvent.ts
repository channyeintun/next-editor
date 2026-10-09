import { workspacePathFromMonacoModelUri, type monaco } from "../../monaco";
import type { TextEditEvent } from "../../types/textEdit";

/**
 * One Monaco content change in `editor`'s model, as the TextEditEvent the
 * workspace and the room apply: null for a model outside the workspace.
 */
export function createMonacoTextEditEvent(
  editor: monaco.editor.IStandaloneCodeEditor,
  changeEvent: monaco.editor.IModelContentChangedEvent,
  beforeVersion: number,
): TextEditEvent | null {
  const model = editor.getModel();
  const modelPath = model ? workspacePathFromMonacoModelUri(model.uri) : null;
  if (!model || !modelPath) return null;

  const changes: TextEditEvent["changes"] = changeEvent.changes.map((change) => ({
    offset: change.rangeOffset,
    deleteLength: change.rangeLength,
    text: change.text,
  }));
  const afterLength = model.getValueLength();
  const lengthDelta = changes.reduce(
    (total, change) => total + change.text.length - change.deleteLength,
    0,
  );
  return {
    fileId: modelPath,
    path: modelPath,
    beforeVersion,
    afterVersion: changeEvent.versionId,
    beforeLength: afterLength - lengthDelta,
    afterLength,
    changes,
  };
}
