import type { CollaborationSurface } from "./protocol";

type EditorSurface = Extract<CollaborationSurface, { kind: "editor" }>;

export function areCollaborationSurfacesEqual(
  left: CollaborationSurface,
  right: CollaborationSurface,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "editor" && right.kind === "editor") {
    if (left.fileNodeId !== right.fileNodeId) return false;
    if (left.viewport === right.viewport) return true;
    if (!left.viewport || !right.viewport) return false;
    return (
      left.viewport.topAnchor === right.viewport.topAnchor &&
      left.viewport.topDeltaPx === right.viewport.topDeltaPx &&
      left.viewport.scrollLeftPx === right.viewport.scrollLeftPx
    );
  }
  if (left.kind === "slides" && right.kind === "slides") {
    return left.isMaximized === right.isMaximized;
  }
  if (left.kind === "whiteboard" && right.kind === "whiteboard") {
    return (
      left.isMaximized === right.isMaximized &&
      left.viewport.scrollX === right.viewport.scrollX &&
      left.viewport.scrollY === right.viewport.scrollY &&
      left.viewport.zoom === right.viewport.zoom
    );
  }
  return false;
}

/** The editor surface on `fileNodeId`, keeping `previous`'s viewport only for the same file. */
export function editorSurfaceOn(previous: EditorSurface, fileNodeId: string | null): EditorSurface {
  return {
    kind: "editor",
    fileNodeId,
    viewport: previous.fileNodeId === fileNodeId ? previous.viewport : null,
  };
}
