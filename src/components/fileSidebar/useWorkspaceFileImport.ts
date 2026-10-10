import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { getUniqueWorkspacePath, joinWorkspacePath } from "../../types/workspacePaths";
import { useWorkspaceActions } from "../../hooks/useWorkspace";
import { useNextEditorActions } from "../../hooks/useNextEditorContext";
import { MAX_WORKSPACE_ASSET_BYTES } from "../../types/workspace";
import { readUploadedWorkspaceFile } from "../../utils/workspaceFileUpload";

/**
 * Adds local files to the workspace, picked through a hidden file input or
 * dropped on the sidebar. Each lands under the chosen folder with a name no
 * other entry has; files too large or unreadable are skipped and listed in
 * one alert.
 */
export function useWorkspaceFileImport() {
  const { createFile, getProject, saveProject } = useWorkspaceActions();
  const { handleWorkspaceEvent } = useNextEditorActions();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetPathRef = useRef("");
  const [isFileDragOver, setIsFileDragOver] = useState(false);

  const importUploadedFiles = async (fileList: FileList | null, parentPath: string) => {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const isPathTaken = (candidatePath: string) => {
      const project = getProject();
      return Boolean(project.files[candidatePath]) || project.folders.includes(candidatePath);
    };

    let firstCreatedPath: string | null = null;
    const skippedNames: string[] = [];

    for (const file of Array.from(fileList)) {
      if (file.size > MAX_WORKSPACE_ASSET_BYTES) {
        skippedNames.push(file.name);
        continue;
      }

      let uploaded;
      try {
        uploaded = await readUploadedWorkspaceFile(file);
      } catch (error) {
        console.warn(`Failed to read uploaded file "${file.name}":`, error);
        skippedNames.push(file.name);
        continue;
      }

      const targetPath = getUniqueWorkspacePath(
        joinWorkspacePath(parentPath, file.name),
        isPathTaken,
      );

      if (!targetPath) {
        skippedNames.push(file.name);
        continue;
      }

      createFile(targetPath, uploaded.content, uploaded.encoding);
      firstCreatedPath = firstCreatedPath ?? targetPath;
    }

    if (firstCreatedPath) {
      void saveProject();
      handleWorkspaceEvent();
    }

    if (skippedNames.length > 0) {
      const limitMb = Math.round(MAX_WORKSPACE_ASSET_BYTES / (1024 * 1024));
      window.alert(
        `Skipped (must be under ${limitMb} MB or unreadable):\n${skippedNames.join("\n")}`,
      );
    }
  };

  /** Opens the file picker; the files picked land in `parentPath`. */
  const openFilePicker = (parentPath: string) => {
    uploadTargetPathRef.current = parentPath;
    uploadInputRef.current?.click();
  };

  const handleUploadInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    void importUploadedFiles(event.target.files, uploadTargetPathRef.current);
    event.target.value = "";
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    // Stop the document-level URL/file drop handler from also importing this as
    // a NextEditor project file; the sidebar drop adds it as a workspace asset.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";

    if (!isFileDragOver) {
      setIsFileDragOver(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsFileDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsFileDragOver(false);
    void importUploadedFiles(event.dataTransfer.files, "");
  };

  return {
    /** For the hidden `<input type="file">` the picker opens through. */
    uploadInputRef,
    handleUploadInputChange,
    openFilePicker,
    /** Whether files are being dragged over the drop target. */
    isFileDragOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
