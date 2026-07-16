import * as Y from "yjs";
import type { WorkspaceActions } from "../contexts/WorkspaceContext";
import {
  getCollaborationTexts,
  projectCollaborationDocument,
  type CollaborationProjectProjection,
} from "./projectDocument";

type ProjectionWorkspaceActions = Pick<
  WorkspaceActions,
  "reconcileExternalProject" | "updateFileContent"
>;

export function reprojectCollaborationWorkspace(
  doc: Y.Doc,
  actions: ProjectionWorkspaceActions,
  assetContentById?: ReadonlyMap<string, string>,
): CollaborationProjectProjection {
  const projection = projectCollaborationDocument(doc, { assetContentById });
  actions.reconcileExternalProject(projection.project);
  return projection;
}

/**
 * Text-only Yjs transactions update just their affected workspace files.
 * Tree/metadata transactions rebuild the path projection once. This prevents
 * a keystroke from replacing the entire path-based project while still making
 * remote edits to inactive files visible to WebContainer sync and recording.
 */
export function projectCollaborationTransaction(
  doc: Y.Doc,
  transaction: Y.Transaction,
  currentProjection: CollaborationProjectProjection | null,
  actions: ProjectionWorkspaceActions,
  assetContentById?: ReadonlyMap<string, string>,
): CollaborationProjectProjection {
  if (!currentProjection) return reprojectCollaborationWorkspace(doc, actions, assetContentById);

  const texts = getCollaborationTexts(doc);
  const textIdByType = new Map<object, string>();
  for (const [id, text] of texts) textIdByType.set(text, id);
  const changedTypes = Array.from(transaction.changed.keys());
  const changedTextIds = changedTypes.flatMap((type) => {
    const id = textIdByType.get(type);
    return id ? [id] : [];
  });
  if (changedTypes.length === 0 || changedTextIds.length !== changedTypes.length) {
    return reprojectCollaborationWorkspace(doc, actions, assetContentById);
  }

  for (const id of new Set(changedTextIds)) {
    const path = currentProjection.pathByNodeId.get(id);
    const text = texts.get(id);
    if (path && text instanceof Y.Text) actions.updateFileContent(path, text.toString());
  }
  return currentProjection;
}
