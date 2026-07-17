import * as Y from "yjs";
import type { WorkspaceActions } from "../contexts/WorkspaceContext";
import type { TextEditEvent } from "../types/textEdit";
import {
  getCollaborationTexts,
  projectCollaborationDocument,
  type CollaborationProjectProjection,
} from "./projectDocument";

type ProjectionWorkspaceActions = Pick<
  WorkspaceActions,
  "reconcileExternalProject" | "updateFileContent"
> &
  Partial<Pick<WorkspaceActions, "applyFileTextEdits">>;

export function reprojectCollaborationWorkspace(
  doc: Y.Doc,
  actions: ProjectionWorkspaceActions,
): CollaborationProjectProjection {
  const projection = projectCollaborationDocument(doc);
  actions.reconcileExternalProject(projection.project);
  return projection;
}

/**
 * Text-only Yjs transactions update just their affected workspace files. A
 * queued local Monaco event is applied directly to the workspace rather than
 * serializing the resulting Y.Text; remote/bulk transactions retain the full
 * text correctness fallback.
 * Tree/metadata transactions rebuild the path projection once. This prevents
 * a keystroke from replacing the entire path-based project while still making
 * remote edits to inactive files visible to WebContainer sync and recording.
 */
export function projectCollaborationTransaction(
  doc: Y.Doc,
  transaction: Y.Transaction,
  currentProjection: CollaborationProjectProjection | null,
  actions: ProjectionWorkspaceActions,
  localTextEdit?: TextEditEvent,
  onLocalTextEditProjected?: (content: string | null) => void,
): CollaborationProjectProjection {
  if (!currentProjection) {
    const projection = reprojectCollaborationWorkspace(doc, actions);
    if (localTextEdit) {
      const file = projection.project.files[localTextEdit.path];
      onLocalTextEditProjected?.(file && typeof file.content === "string" ? file.content : null);
    }
    return projection;
  }

  const texts = getCollaborationTexts(doc);
  const changedTypes = Array.from(transaction.changed.keys());
  const changedTextIds = changedTypes.flatMap((type) => {
    const id = currentProjection.textIdByType.get(type);
    return id ? [id] : [];
  });
  if (changedTypes.length === 0 || changedTextIds.length !== changedTypes.length) {
    return reprojectCollaborationWorkspace(doc, actions);
  }

  for (const id of new Set(changedTextIds)) {
    const path = currentProjection.pathByNodeId.get(id);
    const text = texts.get(id);
    if (!path || !(text instanceof Y.Text)) continue;
    if (localTextEdit?.path === path && actions.applyFileTextEdits) {
      const projectedContent = actions.applyFileTextEdits(localTextEdit);
      if (projectedContent !== null) {
        onLocalTextEditProjected?.(projectedContent);
        continue;
      }
    }
    const content = text.toString();
    actions.updateFileContent(path, content);
    if (localTextEdit?.path === path) onLocalTextEditProjected?.(content);
  }
  return currentProjection;
}
