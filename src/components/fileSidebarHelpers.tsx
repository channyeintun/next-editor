import {
  FileBox,
  FileCode2,
  FileJson2,
  FileText,
  Film,
  Globe,
  ImageIcon,
  Music,
  Package,
  Palette,
} from "lucide-react";
import {
  getParentWorkspacePath,
  getWorkspaceBaseName,
  getWorkspaceMediaKind,
  inferLanguageFromPath,
  type WorkspaceFile,
} from "../types/workspace";

// ============================================================================
// FileSidebar helpers
//
// Pure, render-free building blocks for the FileSidebar component: workspace tree
// construction, file-type icon selection, context-menu viewport placement math,
// new-file templates, and small clipboard/selection utilities. No React state or
// hooks here, so the component file stays focused on interaction wiring.
// ============================================================================

export type WorkspaceTreeNode =
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

export type SidebarEntryKind = "file" | "folder";

export type SidebarEditState =
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

export interface SidebarContextMenuState {
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
export const CONTEXT_MENU_FALLBACK_WIDTH = 224;
export const CONTEXT_MENU_FALLBACK_HEIGHT = 320;
const SIDEBAR_TREE_INDENT = 12;
const SIDEBAR_TREE_OFFSET = 10;

export function getSidebarTreePaddingLeft(depth: number): string {
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

export function getDefaultFileContent(path: string): string {
  const language = inferLanguageFromPath(path);
  return FILE_TEMPLATES[language] ?? "";
}

export function removeFolderFromCollapsedState(
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

export function getFileIcon(file: WorkspaceFile) {
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

export function getEditableSelectionEnd(name: string, kind: "file" | "folder") {
  if (kind === "folder") {
    return name.length;
  }

  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return name.length;
  }

  return extensionIndex;
}

export function copyTextToClipboard(text: string) {
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

export function buildWorkspaceTree(
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
