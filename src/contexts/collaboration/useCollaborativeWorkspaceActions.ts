import { useCallback, useMemo, useRef, type RefObject } from "react";
import { uploadCollaborationAsset } from "@next-editor/infra";
import {
  CollaborationProjectController,
  type CollaborationProjectProjection,
} from "../../collaboration/projectDocument";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import { messageFromError } from "../../collaboration/errorMessage";
import { getWorkspaceAssetBytes } from "../../storage/workspaceAssetStore";
import { applyTextEditEvent, type TextEditEvent } from "../../types/textEdit";
import { isWorkspaceAssetDescriptor, isWorkspaceTextFile } from "../../types/workspace";
import type { WorkspaceActions } from "../../stores/workspaceActions";

interface CollaborativeWorkspaceActionsOptions {
  /** The workspace's own actions, which the room's actions extend. */
  baseActions: WorkspaceActions;
  provider: CollaborationRoomProvider | null;
  providerRef: RefObject<CollaborationRoomProvider | null>;
  playbackRef: RefObject<boolean>;
  /** Whether this member may change the room's document now. */
  canWrite: boolean;
  getCurrentProjection: () => CollaborationProjectProjection | null;
  queueLocalTextEdit: (event: TextEditEvent) => void;
  /** Shows a collaboration error, or clears it with null. */
  setError: (message: string | null) => void;
}

/**
 * The workspace actions inside a room, which write to the room's document
 * (the room's projection then updates the workspace), and a ref to the latest
 * `canWrite`. Outside a room the actions are `baseActions` itself.
 */
export function useCollaborativeWorkspaceActions({
  baseActions,
  provider,
  providerRef,
  playbackRef,
  canWrite,
  getCurrentProjection,
  queueLocalTextEdit,
  setError,
}: CollaborativeWorkspaceActionsOptions) {
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const controller = useMemo(
    () =>
      provider
        ? new CollaborationProjectController(provider.doc, {
            canWrite: () => canWriteRef.current,
            getProjection: getCurrentProjection,
          })
        : null,
    [getCurrentProjection, provider],
  );

  const reportWriteError = useCallback(
    (error: unknown) => {
      setError(messageFromError(error, "The shared workspace could not be changed."));
    },
    [setError],
  );

  const collaborativeActions = useMemo<WorkspaceActions>(() => {
    if (!controller) return baseActions;
    const run = (operation: () => void) => {
      try {
        operation();
        setError(null);
      } catch (error) {
        reportWriteError(error);
      }
    };
    return {
      ...baseActions,
      createFile: (path, content = "", encoding) => {
        if (encoding !== "asset") {
          if (typeof content !== "string") {
            reportWriteError(new Error("Text collaboration files require string content."));
            return;
          }
          run(() => controller.createFile(path, content));
          return;
        }
        if (!isWorkspaceAssetDescriptor(content)) {
          reportWriteError(new Error("Binary collaboration files require an asset descriptor."));
          return;
        }
        const currentProvider = providerRef.current;
        const currentSession = currentProvider?.session;
        if (!currentProvider || !currentSession || !canWriteRef.current) {
          reportWriteError(new Error("The collaboration room is not ready for asset uploads."));
          return;
        }
        void getWorkspaceAssetBytes(content)
          .then((bytes) =>
            uploadCollaborationAsset(currentSession.room.id, bytes, content.mimeType),
          )
          .then((asset) => {
            if (providerRef.current !== currentProvider || !canWriteRef.current) return;
            controller.createAssetFile(path, asset);
            setError(null);
          })
          .catch(reportWriteError);
      },
      createFolder: (path) => run(() => controller.createFolder(path)),
      renameFile: (currentPath, nextPath) =>
        run(() => controller.renameFile(currentPath, nextPath)),
      renameFolder: (currentPath, nextPath) =>
        run(() => controller.renameFolder(currentPath, nextPath)),
      deleteFile: (path) => run(() => controller.deleteFile(path)),
      deleteFolder: (path) => run(() => controller.deleteFolder(path)),
      updateFileContent: (path, content) => run(() => controller.replaceFileContent(path, content)),
      applyFileTextEdits: (event) => {
        try {
          const currentFile = baseActions.getFile(event.path);
          const nextContent =
            currentFile && isWorkspaceTextFile(currentFile)
              ? applyTextEditEvent(currentFile.content, event)
              : null;
          if (nextContent === null) return null;
          queueLocalTextEdit(event);
          const applied = controller.applyFileTextEdits(event);
          setError(null);
          return applied ? nextContent : null;
        } catch (error) {
          reportWriteError(error);
          return null;
        }
      },
      setPreviewFilePath: (path) => run(() => controller.setEntryFile(path)),
      updateLessonType: (lessonType) => run(() => controller.updateLessonType(lessonType)),
      loadProject: () =>
        reportWriteError(new Error("Leave the room before loading another project.")),
      // WebContainerRuntimeProvider sits above CollaborationProvider and uses
      // the base actions, so its reverse sync is switched off by the provider's
      // layout effect rather than refused here.
      reconcileExternalProject: (project) => {
        if (playbackRef.current) baseActions.reconcileExternalProject(project);
        else reportWriteError(new Error("Bulk project replacement is disabled in a live room."));
      },
    };
  }, [
    baseActions,
    controller,
    playbackRef,
    providerRef,
    queueLocalTextEdit,
    reportWriteError,
    setError,
  ]);

  return { canWriteRef, collaborativeActions };
}
