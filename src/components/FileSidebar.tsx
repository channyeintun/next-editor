import { memo, type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FileBox,
  FileCode2,
  FileJson2,
  FilePlus2,
  FileText,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  ImageIcon,
  Music,
  Package,
  Palette,
  Upload,
} from "lucide-react";
import {
  getParentWorkspacePath,
  getUniqueWorkspacePath,
  getWorkspaceBaseName,
  getWorkspaceMediaKind,
  inferLanguageFromPath,
  joinWorkspacePath,
  type WorkspaceFile,
} from "../types/workspace";
import { useWorkspaceActions, useWorkspaceSidebarState } from "../hooks/useWorkspace";
import { MAX_WORKSPACE_ASSET_BYTES, readUploadedWorkspaceFile } from "../utils/workspaceFileUpload";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import {
  DEFAULT_FILE_SIDEBAR_WIDTH,
  FILE_SIDEBAR_KEYBOARD_LARGE_STEP,
  FILE_SIDEBAR_KEYBOARD_STEP,
  getClampedFileSidebarWidth,
  getFileSidebarMaxWidth,
  MIN_FILE_SIDEBAR_WIDTH,
} from "../utils/sidebarLayout";
import { dispatchRecordedCursorVisibility } from "../utils/recordedCursorVisibility";

type WorkspaceTreeNode =
  | {
      kind: "file";
      path: string;
      name: string;
      file: WorkspaceFile;
    }
  | {
      kind: "folder";
      path: string;
      name: string;
      hasActiveFile: boolean;
      children: WorkspaceTreeNode[];
    };

type SidebarEntryKind = "file" | "folder";

type SidebarEditState =
  | {
      mode: "create";
      kind: SidebarEntryKind;
      parentPath: string;
    }
  | {
      mode: "rename";
      kind: SidebarEntryKind;
      path: string;
      parentPath: string;
    }
  | null;

interface SidebarContextMenuState {
  x: number;
  y: number;
  kind: SidebarEntryKind;
  path: string;
  parentPath: string;
}

interface ContextMenuPlacementInput {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

interface ContextMenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
const CONTEXT_MENU_FALLBACK_WIDTH = 224;
const CONTEXT_MENU_FALLBACK_HEIGHT = 320;
const SIDEBAR_TREE_INDENT = 12;
const SIDEBAR_TREE_OFFSET = 10;

function getSidebarTreePaddingLeft(depth: number): string {
  return `${depth * SIDEBAR_TREE_INDENT + SIDEBAR_TREE_OFFSET}px`;
}

function clampViewportValue(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

export function getViewportClampedContextMenuPlacement({
  anchorX,
  anchorY,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
}: ContextMenuPlacementInput): ContextMenuPlacement {
  const availableWidth = Math.max(viewportWidth - margin * 2, 0);
  const availableHeight = Math.max(viewportHeight - margin * 2, 0);
  const renderedWidth = Math.min(Math.max(menuWidth, 0), availableWidth);
  const renderedHeight = Math.min(Math.max(menuHeight, 0), availableHeight);

  return {
    left: clampViewportValue(anchorX, margin, viewportWidth - renderedWidth - margin),
    top: clampViewportValue(anchorY, margin, viewportHeight - renderedHeight - margin),
    maxHeight: availableHeight,
  };
}

const FILE_TEMPLATES: Record<string, string> = {
  css: "body {\n  margin: 0;\n}\n",
  html: '<!doctype html>\n<html lang="en">\n  <body>\n  </body>\n</html>\n',
  javascript: "export function main() {\n  return null;\n}\n",
  json: "{}\n",
  markdown: "# New file\n",
  typescript: "export function main(): null {\n  return null;\n}\n",
};

function getDefaultFileContent(path: string): string {
  const language = inferLanguageFromPath(path);
  return FILE_TEMPLATES[language] ?? "";
}

function getDefaultDraftName(kind: "file" | "folder"): string {
  return kind === "file" ? "new-file.js" : "new-folder";
}

function removeFolderFromCollapsedState(current: Set<string>, folderPath: string): Set<string> {
  if (!folderPath || !current.has(folderPath)) {
    return current;
  }

  const next = new Set(current);
  next.delete(folderPath);
  return next;
}

function getFileIcon(file: WorkspaceFile) {
  if (file.encoding === "base64") {
    const mediaKind = getWorkspaceMediaKind(file.path);

    if (mediaKind === "image") {
      return <ImageIcon size={14} className="text-fuchsia-300" />;
    }

    if (mediaKind === "video") {
      return <Film size={14} className="text-rose-300" />;
    }

    if (mediaKind === "audio") {
      return <Music size={14} className="text-teal-300" />;
    }

    return <FileBox size={14} className="text-slate-300" />;
  }

  if (file.path === "package.json") {
    return <Package size={14} className="text-emerald-300" />;
  }

  if (file.language === "css") {
    return <Palette size={14} className="text-pink-300" />;
  }

  if (file.language === "json") {
    return <FileJson2 size={14} className="text-amber-300" />;
  }

  if (file.language === "html") {
    return <Globe size={14} className="text-sky-300" />;
  }

  if (file.language === "markdown") {
    return <FileText size={14} className="text-violet-300" />;
  }

  if (file.language === "javascript" || file.language === "typescript") {
    return <FileCode2 size={14} className="text-cyan-300" />;
  }

  return <FileText size={14} className="text-slate-300" />;
}

function getEditableSelectionEnd(name: string, kind: "file" | "folder") {
  if (kind === "folder") {
    return name.length;
  }

  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return name.length;
  }

  return extensionIndex;
}

function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function buildWorkspaceTree(
  files: WorkspaceFile[],
  folders: string[],
  activeFilePath: string,
): WorkspaceTreeNode[] {
  const root = {
    kind: "folder" as const,
    path: "",
    name: "",
    hasActiveFile: true,
    children: [] as WorkspaceTreeNode[],
  };
  const folderMap = new Map<string, Extract<WorkspaceTreeNode, { kind: "folder" }>>([["", root]]);

  const ensureFolderNode = (folderPath: string) => {
    if (folderMap.has(folderPath)) {
      return folderMap.get(folderPath)!;
    }

    const parentPath = getParentWorkspacePath(folderPath);
    const parentNode = ensureFolderNode(parentPath);
    const folderNode: Extract<WorkspaceTreeNode, { kind: "folder" }> = {
      kind: "folder",
      path: folderPath,
      name: getWorkspaceBaseName(folderPath),
      hasActiveFile: activeFilePath === folderPath || activeFilePath.startsWith(`${folderPath}/`),
      children: [],
    };

    parentNode.children.push(folderNode);
    folderMap.set(folderPath, folderNode);
    return folderNode;
  };

  for (const folderPath of folders) {
    ensureFolderNode(folderPath);
  }

  for (const file of files) {
    const parentPath = getParentWorkspacePath(file.path);
    const parentNode = ensureFolderNode(parentPath);
    parentNode.children.push({
      kind: "file",
      path: file.path,
      name: file.name,
      file,
    });
  }

  const sortNodes = (nodes: WorkspaceTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "folder" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });

    for (const node of nodes) {
      if (node.kind === "folder") {
        sortNodes(node.children);
      }
    }
  };

  sortNodes(root.children);
  return root.children;
}

const FileSidebar = memo(function FileSidebar() {
  const [draftName, setDraftName] = useState("");
  const [editState, setEditState] = useState<SidebarEditState>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetPathRef = useRef("");
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollAnimationFrameRef = useRef<number | null>(null);
  const pendingSidebarScrollTopRef = useRef(0);
  const sidebarResizeStartRef = useRef({
    x: 0,
    y: 0,
    width: DEFAULT_FILE_SIDEBAR_WIDTH,
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [contextMenuSize, setContextMenuSize] = useState({
    width: CONTEXT_MENU_FALLBACK_WIDTH,
    height: CONTEXT_MENU_FALLBACK_HEIGHT,
  });
  const {
    createFile,
    createFolder,
    deleteFile,
    deleteFolder,
    getProject,
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
  } = useWorkspaceSidebarState();
  const collapsedFolders = useMemo(() => new Set(collapsedFolderPaths), [collapsedFolderPaths]);
  const tree = useMemo(
    () => buildWorkspaceTree(files, folders, activeFilePath),
    [activeFilePath, files, folders],
  );
  const menuStyle = useMemo(() => {
    if (!contextMenu) {
      return undefined;
    }

    const placement = getViewportClampedContextMenuPlacement({
      anchorX: contextMenu.x,
      anchorY: contextMenu.y,
      menuWidth: contextMenuSize.width,
      menuHeight: contextMenuSize.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });

    return {
      left: placement.left,
      top: placement.top,
      maxHeight: placement.maxHeight,
    };
  }, [contextMenu, contextMenuSize]);
  const contextMenuFile = useMemo(() => {
    if (!contextMenu || contextMenu.kind !== "file") {
      return null;
    }

    return files.find((file) => file.path === contextMenu.path) ?? null;
  }, [contextMenu, files]);
  const canOpenContextFileInPreview =
    lessonType !== "react" && contextMenuFile?.language === "html";
  const isContextFileInPreview = contextMenu?.path === previewFilePath;
  const contextMenuCreateParentPath =
    contextMenu?.kind === "folder" ? contextMenu.path : (contextMenu?.parentPath ?? "");

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

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      return;
    }

    const menu = contextMenuRef.current;
    const bounds = menu.getBoundingClientRect();
    const nextSize = {
      width: bounds.width || CONTEXT_MENU_FALLBACK_WIDTH,
      height: menu.scrollHeight || bounds.height || CONTEXT_MENU_FALLBACK_HEIGHT,
    };

    setContextMenuSize((currentSize) => {
      if (currentSize.width === nextSize.width && currentSize.height === nextSize.height) {
        return currentSize;
      }

      return nextSize;
    });
  }, [contextMenu, canOpenContextFileInPreview]);

  useEffect(() => {
    return () => {
      if (sidebarScrollAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarScrollAnimationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleWindowResize = () => {
      setSidebarWidth(getClampedFileSidebarWidth(sidebarWidth, window.innerWidth));
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [setSidebarWidth, sidebarWidth]);

  useEffect(() => {
    if (!isResizingSidebar) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      const dragOffset = event.clientX - sidebarResizeStartRef.current.x;
      const nextWidth = sidebarResizeStartRef.current.width + dragOffset;
      setSidebarWidth(getClampedFileSidebarWidth(nextWidth, window.innerWidth));
      dispatchRecordedCursorVisibility({
        x: event.clientX,
        y: event.clientY,
        visible: false,
      });
    };

    const stopResizing = (event: PointerEvent) => {
      dispatchRecordedCursorVisibility({
        x: event.clientX,
        y: event.clientY,
        visible: true,
      });
      setIsResizingSidebar(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingSidebar, setSidebarWidth]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

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
    setDraftName(getDefaultDraftName(kind));
  };

  const handleCreateFile = () => {
    openCreateInput("file", "");
  };

  const handleCreateFolder = () => {
    openCreateInput("folder", "");
  };

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
      createFile(targetPath, uploaded.content, uploaded.encoding);
      firstCreatedPath = firstCreatedPath ?? targetPath;
    }

    if (firstCreatedPath) {
      saveProject();
      handleWorkspaceEvent();
    }

    if (skippedNames.length > 0) {
      const limitMb = Math.round(MAX_WORKSPACE_ASSET_BYTES / (1024 * 1024));
      window.alert(
        `Skipped (must be under ${limitMb} MB or unreadable):\n${skippedNames.join("\n")}`,
      );
    }
  };

  const openUploadDialog = (parentPath: string) => {
    uploadTargetPathRef.current = parentPath;
    setContextMenu(null);
    uploadInputRef.current?.click();
  };

  const handleUploadInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    void importUploadedFiles(event.target.files, uploadTargetPathRef.current);
    event.target.value = "";
  };

  const handleSidebarDragOver = (event: React.DragEvent<HTMLElement>) => {
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

  const handleSidebarDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsFileDragOver(false);
  };

  const handleSidebarDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsFileDragOver(false);
    void importUploadedFiles(event.dataTransfer.files, "");
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
    saveProject();
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

  const handleSidebarResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: sidebarWidth,
    };
    dispatchRecordedCursorVisibility({
      x: event.clientX,
      y: event.clientY,
      visible: false,
    });
    setIsResizingSidebar(true);
  };

  const handleSidebarResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number;

    switch (event.key) {
      case "ArrowLeft":
        nextWidth =
          sidebarWidth -
          (event.shiftKey ? FILE_SIDEBAR_KEYBOARD_LARGE_STEP : FILE_SIDEBAR_KEYBOARD_STEP);
        break;
      case "ArrowRight":
        nextWidth =
          sidebarWidth +
          (event.shiftKey ? FILE_SIDEBAR_KEYBOARD_LARGE_STEP : FILE_SIDEBAR_KEYBOARD_STEP);
        break;
      case "Home":
        nextWidth = MIN_FILE_SIDEBAR_WIDTH;
        break;
      case "End":
        nextWidth = getFileSidebarMaxWidth(window.innerWidth);
        break;
      default:
        return;
    }

    event.preventDefault();
    setSidebarWidth(getClampedFileSidebarWidth(nextWidth, window.innerWidth));
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
          className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5"
          style={{ paddingLeft: getSidebarTreePaddingLeft(depth) }}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
          <input
            ref={editInputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={handleDraftKeyDown}
            onBlur={commitInlineEdit}
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-slate-100 outline-none"
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
                    <FolderOpen size={13} className="text-sky-300" />
                  ) : (
                    <Folder size={13} className="text-slate-500" />
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
      className="relative flex h-full shrink-0 flex-col border-r border-slate-800 bg-[#11141c] text-slate-100"
      style={{ width: sidebarWidth }}
      data-cursor-replay-target="file-sidebar"
      onDragOver={handleSidebarDragOver}
      onDragLeave={handleSidebarDragLeave}
      onDrop={handleSidebarDrop}
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

        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="fixed z-60 min-w-56 overflow-y-auto rounded-xl border border-slate-700 bg-[#1b2029] py-2 shadow-[0_20px_40px_rgba(2,6,23,0.55)]"
            style={menuStyle}
          >
            <button
              type="button"
              onClick={() => openCreateInput("file", contextMenuCreateParentPath)}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              New File
            </button>
            <button
              type="button"
              onClick={() => openCreateInput("folder", contextMenuCreateParentPath)}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              New Folder
            </button>
            <button
              type="button"
              onClick={() => openUploadDialog(contextMenuCreateParentPath)}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              Upload Files Here
            </button>
            {canOpenContextFileInPreview ? (
              <button
                type="button"
                onClick={() => handleOpenFileInPreview(contextMenu.path)}
                className={`flex w-full items-center px-4 py-2 text-sm transition-colors ${
                  isContextFileInPreview
                    ? "text-sky-200 hover:bg-slate-800"
                    : "text-slate-200 hover:bg-slate-800"
                }`}
              >
                Open in Preview
              </button>
            ) : null}
            <div className="my-2 border-t border-slate-700" />
            <button
              type="button"
              onClick={() => {
                copyTextToClipboard(`/${contextMenu.path}`);
                setContextMenu(null);
              }}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              Copy Path
            </button>
            <button
              type="button"
              onClick={() => {
                copyTextToClipboard(contextMenu.path);
                setContextMenu(null);
              }}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              Copy Relative Path
            </button>
            <div className="my-2 border-t border-slate-700" />
            <button
              type="button"
              onClick={() => startRenameEntry(contextMenu.kind, contextMenu.path)}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => handleDeleteEntry(contextMenu.kind, contextMenu.path)}
              className="flex w-full items-center px-4 py-2 text-sm text-rose-200 transition-colors hover:bg-rose-500/10"
            >
              {contextMenu.kind === "folder" ? "Delete Folder" : "Delete File"}
            </button>
          </div>
        )}
      </div>
      {isResizingSidebar ? (
        <div aria-hidden="true" className="fixed inset-0 z-40 cursor-col-resize" />
      ) : null}
      <div
        role="separator"
        aria-label="Resize file sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_FILE_SIDEBAR_WIDTH}
        aria-valuemax={getFileSidebarMaxWidth(
          typeof window === "undefined" ? undefined : window.innerWidth,
        )}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={handleSidebarResizePointerDown}
        onKeyDown={handleSidebarResizeKeyDown}
        className={`absolute inset-y-0 -right-1 z-50 w-2 cursor-col-resize touch-none outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sky-400 focus-visible:before:bg-sky-400 ${
          isResizingSidebar ? "before:bg-sky-400" : ""
        }`}
      />
    </aside>
  );
});

export default FileSidebar;
