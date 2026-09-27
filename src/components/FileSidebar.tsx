import { type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FolderPlus, Upload } from "lucide-react";
import {
  getParentWorkspacePath,
  getWorkspaceBaseName,
  joinWorkspacePath,
} from "../types/workspace";
import {
  useWorkspaceActions,
  useWorkspaceSidebarCollapsed,
  useWorkspaceSidebarState,
  useWorkspaceSidebarWidth,
} from "../hooks/useWorkspace";
import { useCollapseTransition } from "../hooks/useCollapseTransition";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { STUDIO_TARGET_ATTRIBUTE, studioTargetIdForFile } from "../studio/targets";
import FileContextMenu from "./fileSidebar/FileContextMenu";
import SidebarResizeHandle from "./fileSidebar/SidebarResizeHandle";
import { useWorkspaceFileImport } from "./fileSidebar/useWorkspaceFileImport";
import {
  buildWorkspaceTree,
  deletesEveryFile,
  getDefaultFileContent,
  getEditableSelectionEnd,
  getFileIcon,
  getSidebarTreePaddingLeft,
  removeFolderFromCollapsedState,
  type SidebarContextMenuState,
  type SidebarEditState,
  type SidebarEntryKind,
  type WorkspaceTreeNode,
} from "./fileSidebarHelpers";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";

function FileSidebarPanel() {
  const collaboration = useOptionalCollaboration();
  const [draftName, setDraftName] = useState("");
  const [editState, setEditState] = useState<SidebarEditState>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollAnimationFrameRef = useRef<number | null>(null);
  const pendingSidebarScrollTopRef = useRef(0);
  const {
    uploadInputRef,
    handleUploadInputChange,
    openFilePicker,
    isFileDragOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useWorkspaceFileImport();
  const {
    createFile,
    createFolder,
    deleteFile,
    deleteFolder,
    renameFile,
    renameFolder,
    saveProject,
    setActiveFilePath,
    setCollapsedFolders,
    setSidebarScrollTop,
    setSidebarWidth,
    setPreviewFilePath,
  } = useWorkspaceActions();
  const { handleWorkspaceEvent } = useNextEditorActions();
  const {
    activeFilePath,
    collapsedFolders: collapsedFolderPaths,
    files,
    folders,
    lessonType,
    previewFilePath,
    sidebarScrollTop,
    sidebarWidth,
    treeVersion,
  } = useWorkspaceSidebarState();
  const collapsedFolders = new Set(collapsedFolderPaths);
  const tree = useMemo(
    () => buildWorkspaceTree(files, folders, activeFilePath),
    [activeFilePath, files, folders, treeVersion],
  );
  const contextMenuFile =
    contextMenu && contextMenu.kind === "file"
      ? (files.find((file) => file.path === contextMenu.path) ?? null)
      : null;
  const isDeleteRefused = contextMenu !== null && deletesEveryFile(files, contextMenu.path);
  const canOpenContextFileInPreview =
    lessonType !== "react" && contextMenuFile?.language === "html";
  const isContextFileInPreview = contextMenu?.path === previewFilePath;

  useEffect(() => {
    if (!editState || !editInputRef.current) {
      return;
    }

    const input = editInputRef.current;
    input.focus();
    const selectionEnd = getEditableSelectionEnd(input.value, editState.kind);
    input.setSelectionRange(0, selectionEnd);
  }, [editState]);

  useLayoutEffect(() => {
    const container = sidebarScrollContainerRef.current;
    if (!container) {
      return;
    }

    pendingSidebarScrollTopRef.current = sidebarScrollTop;

    if (Math.abs(container.scrollTop - sidebarScrollTop) > 1) {
      container.scrollTop = sidebarScrollTop;
    }
  }, [sidebarScrollTop]);

  useEffect(() => {
    return () => {
      if (sidebarScrollAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarScrollAnimationFrameRef.current);
      }
    };
  }, []);

  const commitCollapsedFolders = (next: Set<string>) => {
    const nextPaths = Array.from(next).sort((left, right) => left.localeCompare(right));

    if (
      nextPaths.length === collapsedFolderPaths.length &&
      nextPaths.every((path, index) => path === collapsedFolderPaths[index])
    ) {
      return;
    }

    setCollapsedFolders(nextPaths);
  };

  const clearInlineEdit = () => {
    setEditState(null);
    setDraftName("");
  };

  const openCreateInput = (kind: SidebarEntryKind, parentPath: string) => {
    setContextMenu(null);
    commitCollapsedFolders(removeFolderFromCollapsedState(collapsedFolders, parentPath));
    setEditState({
      mode: "create",
      kind,
      parentPath,
    });
    setDraftName("");
  };

  const handleCreateFile = () => {
    openCreateInput("file", "");
  };

  const handleCreateFolder = () => {
    openCreateInput("folder", "");
  };

  const openUploadDialog = (parentPath: string) => {
    setContextMenu(null);
    openFilePicker(parentPath);
  };

  const startRenameEntry = (kind: SidebarEntryKind, path: string) => {
    setContextMenu(null);
    setEditState({
      mode: "rename",
      kind,
      path,
      parentPath: getParentWorkspacePath(path),
    });
    setDraftName(getWorkspaceBaseName(path));
  };

  const commitInlineEdit = () => {
    if (!editState) {
      return;
    }

    const normalizedName = draftName.trim();
    if (!normalizedName) {
      clearInlineEdit();
      return;
    }

    const nextPath = joinWorkspacePath(editState.parentPath, normalizedName);

    if (!nextPath) {
      return;
    }

    if (editState.mode === "create") {
      if (editState.kind === "file") {
        createFile(nextPath, getDefaultFileContent(nextPath));
      } else {
        createFolder(nextPath);
      }

      clearInlineEdit();
      return;
    }

    if (nextPath !== editState.path) {
      if (editState.kind === "file") {
        renameFile(editState.path, nextPath);
      } else {
        renameFolder(editState.path, nextPath);
      }
    }

    clearInlineEdit();
  };

  const handleDeleteEntry = (kind: SidebarEntryKind, path: string) => {
    setContextMenu(null);

    const confirmed = window.confirm(
      kind === "folder" ? `Delete folder ${path} and its contents?` : `Delete ${path}?`,
    );

    if (!confirmed) {
      return;
    }

    if (kind === "folder") {
      deleteFolder(path);
      return;
    }

    deleteFile(path);
  };

  const handleOpenFileInPreview = (path: string) => {
    setPreviewFilePath(path);
    void saveProject();
    setContextMenu(null);
  };

  const handleDraftKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitInlineEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      clearInlineEdit();
    }
  };

  const openFile = (path: string) => {
    collaboration?.stopFollowing("local-file-navigation");
    setActiveFilePath(path);
    handleWorkspaceEvent();
  };

  const handleSidebarScroll = (event: UIEvent<HTMLDivElement>) => {
    pendingSidebarScrollTopRef.current = event.currentTarget.scrollTop;

    if (sidebarScrollAnimationFrameRef.current !== null) {
      return;
    }

    sidebarScrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
      sidebarScrollAnimationFrameRef.current = null;
      setSidebarScrollTop(pendingSidebarScrollTopRef.current);
    });
  };

  const handleRowContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    kind: SidebarEntryKind,
    path: string,
  ) => {
    event.preventDefault();

    if (kind === "file") {
      openFile(path);
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      kind,
      path,
      parentPath: getParentWorkspacePath(path),
    });
  };

  const toggleFolder = (path: string) => {
    const next = new Set(collapsedFolders);

    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }

    commitCollapsedFolders(next);
  };

  const renderInlineInput = (kind: "file" | "folder", depth: number) => {
    const icon =
      kind === "folder" ? (
        <FolderPlus size={13} className="text-slate-400" />
      ) : (
        <FilePlus2 size={13} className="text-slate-400" />
      );

    return (
      <div className="px-1.5">
        <div
          className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 transition-colors focus-within:border-slate-500"
          style={{ paddingLeft: getSidebarTreePaddingLeft(depth) }}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
          <input
            ref={editInputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={handleDraftKeyDown}
            onBlur={commitInlineEdit}
            placeholder={kind === "folder" ? "Folder name" : "File name"}
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-500"
          />
        </div>
      </div>
    );
  };

  const renderNode = (node: WorkspaceTreeNode, depth: number): React.ReactNode => {
    if (node.kind === "folder") {
      const isEditing = editState?.mode === "rename" && editState.path === node.path;
      const isCollapsed = collapsedFolders.has(node.path);
      const isExpanded = !isCollapsed;

      return (
        <div key={node.path} className="space-y-0.5">
          {isEditing ? (
            renderInlineInput("folder", depth)
          ) : (
            <div className="px-1.5">
              <button
                type="button"
                onClick={() => toggleFolder(node.path)}
                onContextMenu={(event) => handleRowContextMenu(event, "folder", node.path)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 transition-colors hover:bg-slate-900 ${
                  node.hasActiveFile ? "text-slate-200" : "text-slate-400"
                }`}
                style={{ paddingLeft: getSidebarTreePaddingLeft(depth) }}
                aria-expanded={isExpanded}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {isExpanded || node.hasActiveFile ? (
                    <svg
                      width={13}
                      height={13}
                      viewBox="0 0 16 16"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path fill="#5c99d6" d="M1 6v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6z" />
                      <path
                        fill="#3d7ab5"
                        d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v2h14V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"
                      />
                    </svg>
                  ) : (
                    <svg
                      width={13}
                      height={13}
                      viewBox="0 0 16 16"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        fill="#78909c"
                        d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"
                      />
                    </svg>
                  )}
                </span>
                <span className="truncate font-medium">{node.name}</span>
              </button>
            </div>
          )}

          {editState?.mode === "create" && editState.parentPath === node.path
            ? renderInlineInput(editState.kind, depth + 1)
            : null}

          {isExpanded ? node.children.map((child) => renderNode(child, depth + 1)) : null}
        </div>
      );
    }

    const isEditing = editState?.mode === "rename" && editState.path === node.path;
    const isActive = activeFilePath === node.path;

    if (isEditing) {
      return <div key={node.path}>{renderInlineInput("file", depth)}</div>;
    }

    return (
      <div key={node.path} className="px-1.5">
        <button
          type="button"
          {...{ [STUDIO_TARGET_ATTRIBUTE]: studioTargetIdForFile(node.path) }}
          onClick={() => openFile(node.path)}
          onContextMenu={(event) => handleRowContextMenu(event, "file", node.path)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 transition-colors ${
            isActive
              ? "bg-slate-800 text-white"
              : "text-slate-300 hover:bg-slate-900 hover:text-white"
          }`}
          style={{ paddingLeft: getSidebarTreePaddingLeft(depth) }}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {getFileIcon(node.file)}
          </span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
      </div>
    );
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col bg-[#11141c] text-slate-100"
      style={{ width: sidebarWidth }}
      data-cursor-replay-target="file-sidebar"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="border-b border-slate-800 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
            Files
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCreateFile}
              className="inline-flex size-5 items-center justify-center text-slate-400 transition-colors hover:text-white"
              aria-label="Create file"
              title="Create file"
            >
              <FilePlus2 size={14} />
            </button>
            <button
              type="button"
              onClick={handleCreateFolder}
              className="inline-flex size-5 items-center justify-center text-slate-400 transition-colors hover:text-white"
              aria-label="Create folder"
              title="Create folder"
            >
              <FolderPlus size={14} />
            </button>
            <button
              type="button"
              onClick={() => openUploadDialog("")}
              className="inline-flex size-5 items-center justify-center text-slate-400 transition-colors hover:text-white"
              aria-label="Upload files"
              title="Upload local files (images, video, assets)"
            >
              <Upload size={14} />
            </button>
          </div>
        </div>
      </div>
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadInputChange}
      />
      {isFileDragOver ? (
        // z-110 keeps this above the app-wide drag overlay (z-105) so the
        // sidebar shows the correct "add as asset" hint while dragging.
        <div className="pointer-events-none absolute inset-0 z-110 flex items-center justify-center bg-[#11141c]/80 px-4">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-sky-400/70 bg-[#11141c] px-6 py-5 text-center">
            <Upload size={22} className="text-sky-300" />
            <p className="text-xs font-medium text-slate-200">Drop files to add to the workspace</p>
          </div>
        </div>
      ) : null}

      <div
        ref={sidebarScrollContainerRef}
        onScroll={handleSidebarScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-1.5 py-2"
      >
        <div className="space-y-0.5">
          {editState?.mode === "create" && editState.parentPath === ""
            ? renderInlineInput(editState.kind, 0)
            : null}
          {tree.map((node) => renderNode(node, 0))}
        </div>

        <FileContextMenu
          menu={contextMenu}
          canOpenInPreview={canOpenContextFileInPreview}
          isInPreview={isContextFileInPreview}
          isDeleteRefused={isDeleteRefused}
          onDismiss={() => setContextMenu(null)}
          onCreate={openCreateInput}
          onUpload={openUploadDialog}
          onOpenInPreview={handleOpenFileInPreview}
          onRename={startRenameEntry}
          onDelete={handleDeleteEntry}
        />
      </div>
      <SidebarResizeHandle width={sidebarWidth} onWidthChange={setSidebarWidth} />
    </aside>
  );
}

function FileSidebar() {
  const isCollapsed = useWorkspaceSidebarCollapsed();
  const sidebarWidth = useWorkspaceSidebarWidth();
  const { isMounted, isExpanded, isAnimating } = useCollapseTransition(isCollapsed);

  // Clip only while sliding (or fully collapsed); when idle-open the wrapper must
  // not clip the resize handle, which sits just past the panel's right edge.
  const shouldClip = isAnimating || isCollapsed;

  return (
    <div
      className={`shrink-0 ${shouldClip ? "overflow-hidden" : ""} ${
        isAnimating ? "transition-[width] duration-200 ease-out motion-reduce:transition-none" : ""
      }`}
      style={{ width: isExpanded ? sidebarWidth : 0 }}
      aria-hidden={isCollapsed ? true : undefined}
    >
      {isMounted ? <FileSidebarPanel /> : null}
    </div>
  );
}

export default FileSidebar;
