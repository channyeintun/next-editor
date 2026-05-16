import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  FileCode2,
  FileJson2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Package,
  Palette,
} from "lucide-react";
import {
  getParentWorkspacePath,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  joinWorkspacePath,
  type WorkspaceFile,
} from "../types/workspace";
import {
  useWorkspaceActions,
  useWorkspaceSidebarState,
} from "../hooks/useWorkspace";

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

function removeFolderFromCollapsedState(
  current: Set<string>,
  folderPath: string,
): Set<string> {
  if (!folderPath || !current.has(folderPath)) {
    return current;
  }

  const next = new Set(current);
  next.delete(folderPath);
  return next;
}

function getFileIcon(file: WorkspaceFile) {
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
  const folderMap = new Map<
    string,
    Extract<WorkspaceTreeNode, { kind: "folder" }>
  >([["", root]]);

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
      hasActiveFile:
        activeFilePath === folderPath ||
        activeFilePath.startsWith(`${folderPath}/`),
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
  const [contextMenu, setContextMenu] =
    useState<SidebarContextMenuState | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
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
    setPreviewFilePath,
  } = useWorkspaceActions();
  const {
    activeFilePath,
    collapsedFolders: collapsedFolderPaths,
    files,
    folders,
    lessonType,
    previewFilePath,
  } = useWorkspaceSidebarState();
  const collapsedFolders = useMemo(
    () => new Set(collapsedFolderPaths),
    [collapsedFolderPaths],
  );
  const tree = useMemo(
    () => buildWorkspaceTree(files, folders, activeFilePath),
    [activeFilePath, files, folders],
  );
  const menuStyle = useMemo(() => {
    if (!contextMenu) {
      return undefined;
    }

    return {
      left: Math.min(contextMenu.x, window.innerWidth - 240),
      top: Math.min(contextMenu.y, window.innerHeight - 240),
    };
  }, [contextMenu]);
  const contextMenuFile = useMemo(() => {
    if (!contextMenu || contextMenu.kind !== "file") {
      return null;
    }

    return files.find((file) => file.path === contextMenu.path) ?? null;
  }, [contextMenu, files]);
  const canOpenContextFileInPreview =
    lessonType !== "node.js" && contextMenuFile?.language === "html";
  const isContextFileInPreview = contextMenu?.path === previewFilePath;
  const contextMenuCreateParentPath =
    contextMenu?.kind === "folder"
      ? contextMenu.path
      : (contextMenu?.parentPath ?? "");

  useEffect(() => {
    if (!editState || !editInputRef.current) {
      return;
    }

    const input = editInputRef.current;
    input.focus();
    const selectionEnd = getEditableSelectionEnd(input.value, editState.kind);
    input.setSelectionRange(0, selectionEnd);
  }, [editState]);

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
    const nextPaths = Array.from(next).sort((left, right) =>
      left.localeCompare(right),
    );

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
    commitCollapsedFolders(
      removeFolderFromCollapsedState(collapsedFolders, parentPath),
    );
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
      kind === "folder"
        ? `Delete folder ${path} and its contents?`
        : `Delete ${path}?`,
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

  const handleRowContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    kind: SidebarEntryKind,
    path: string,
  ) => {
    event.preventDefault();

    if (kind === "file") {
      setActiveFilePath(path);
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
        <FolderPlus size={14} className="text-slate-400" />
      ) : (
        <FilePlus2 size={14} className="text-slate-400" />
      );

    return (
      <div className="px-2">
        <div
          className="flex items-center gap-3 rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          <span className="flex shrink-0 items-center justify-center size-5">
            {icon}
          </span>
          <input
            ref={editInputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={handleDraftKeyDown}
            onBlur={commitInlineEdit}
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none"
          />
        </div>
      </div>
    );
  };

  const renderNode = (
    node: WorkspaceTreeNode,
    depth: number,
  ): React.ReactNode => {
    if (node.kind === "folder") {
      const isEditing =
        editState?.mode === "rename" && editState.path === node.path;
      const isCollapsed = collapsedFolders.has(node.path);
      const isExpanded = !isCollapsed;

      return (
        <div key={node.path} className="space-y-1">
          {isEditing ? (
            renderInlineInput("folder", depth)
          ) : (
            <div className="px-2">
              <button
                type="button"
                onClick={() => toggleFolder(node.path)}
                onContextMenu={(event) =>
                  handleRowContextMenu(event, "folder", node.path)
                }
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-slate-900 ${
                  node.hasActiveFile ? "text-slate-200" : "text-slate-400"
                }`}
                style={{ paddingLeft: `${depth * 16 + 12}px` }}
                aria-expanded={isExpanded}
              >
                <span className="flex shrink-0 items-center justify-center size-5">
                  {isExpanded || node.hasActiveFile ? (
                    <FolderOpen size={14} className="text-sky-300" />
                  ) : (
                    <Folder size={14} className="text-slate-500" />
                  )}
                </span>
                <span className="truncate font-medium">{node.name}</span>
              </button>
            </div>
          )}

          {editState?.mode === "create" && editState.parentPath === node.path
            ? renderInlineInput(editState.kind, depth + 1)
            : null}

          {isExpanded
            ? node.children.map((child) => renderNode(child, depth + 1))
            : null}
        </div>
      );
    }

    const isEditing =
      editState?.mode === "rename" && editState.path === node.path;
    const isActive = activeFilePath === node.path;

    if (isEditing) {
      return <div key={node.path}>{renderInlineInput("file", depth)}</div>;
    }

    return (
      <div key={node.path} className="px-2">
        <button
          type="button"
          onClick={() => setActiveFilePath(node.path)}
          onContextMenu={(event) =>
            handleRowContextMenu(event, "file", node.path)
          }
          className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
            isActive
              ? "bg-slate-800 text-white"
              : "text-slate-300 hover:bg-slate-900 hover:text-white"
          }`}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          <span className="flex shrink-0 items-center justify-center size-5">
            {getFileIcon(node.file)}
          </span>
          <span className="truncate text-sm font-medium">{node.name}</span>
        </button>
      </div>
    );
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-800 bg-[#11141c] text-slate-100">
      <div className="border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
            Files
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreateFile}
              className="inline-flex items-center justify-center text-slate-400 transition-colors hover:text-white size-6"
              aria-label="Create file"
              title="Create file"
            >
              <FilePlus2 size={15} />
            </button>
            <button
              type="button"
              onClick={handleCreateFolder}
              className="inline-flex items-center justify-center text-slate-400 transition-colors hover:text-white size-6"
              aria-label="Create folder"
              title="Create folder"
            >
              <FolderPlus size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <div className="space-y-1">
          {editState?.mode === "create" && editState.parentPath === ""
            ? renderInlineInput(editState.kind, 0)
            : null}
          {tree.map((node) => renderNode(node, 0))}
        </div>

        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="fixed z-60 min-w-56 overflow-hidden rounded-xl border border-slate-700 bg-[#1b2029] py-2 shadow-[0_20px_40px_rgba(2,6,23,0.55)]"
            style={menuStyle}
          >
            <button
              type="button"
              onClick={() =>
                openCreateInput("file", contextMenuCreateParentPath)
              }
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              New File
            </button>
            <button
              type="button"
              onClick={() =>
                openCreateInput("folder", contextMenuCreateParentPath)
              }
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              New Folder
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
              onClick={() =>
                startRenameEntry(contextMenu.kind, contextMenu.path)
              }
              className="flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() =>
                handleDeleteEntry(contextMenu.kind, contextMenu.path)
              }
              className="flex w-full items-center px-4 py-2 text-sm text-rose-200 transition-colors hover:bg-rose-500/10"
            >
              {contextMenu.kind === "folder" ? "Delete Folder" : "Delete File"}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
});

export default FileSidebar;
