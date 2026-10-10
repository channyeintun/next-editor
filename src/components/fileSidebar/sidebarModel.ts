import type { WorkspaceProject, WorkspaceTreeFile } from "../../types/workspace";
import { getParentWorkspacePath, getWorkspaceBaseName } from "../../types/workspacePaths";
import { inferLanguageFromPath } from "../../types/workspaceFiles";
import {
  describeWorkspacePathConflict,
  isPathWithinFolder,
} from "../../stores/workspaceProjectSupport";

// ============================================================================
// FileSidebar model
//
// The sidebar's data, without React: the workspace tree and its row indent,
// the inline create/rename edit state and the rules for the names it takes,
// new-file templates, and small selection and collapse utilities. File and
// folder icons live in fileIcons.tsx, and context-menu placement in
// contextMenuPlacement.ts.
// ============================================================================

export type WorkspaceTreeNode =
  | {
      kind: "file";
      path: string;
      name: string;
      file: WorkspaceTreeFile;
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

const SIDEBAR_TREE_INDENT = 12;
const SIDEBAR_TREE_OFFSET = 10;

export function getSidebarTreePaddingLeft(depth: number): string {
  return `${depth * SIDEBAR_TREE_INDENT + SIDEBAR_TREE_OFFSET}px`;
}

const FILE_TEMPLATES: Record<string, string> = {
  css: "body {\n  margin: 0;\n}\n",
  // A signature and a definition, because an empty .hs file is a module with
  // no `main`, and the first thing GHC would say about it is that `main` is
  // missing rather than anything the lesson is about.
  haskell: 'main :: IO ()\nmain = putStrLn "Hello, Haskell!"\n',
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

/**
 * Whether deleting the entry at `path` (a file, or a folder with everything in
 * it) would remove every file. The sidebar disables that delete, and the local
 * workspace store also refuses it: a project always keeps at least one file.
 */
export function deletesEveryFile(files: readonly WorkspaceTreeFile[], path: string): boolean {
  return files.every((file) => isPathWithinFolder(file.path, path));
}

/**
 * Why the inline name field cannot take `nextPath` for a new or renamed
 * (`currentPath`) entry of `kind`, or null when it can. The workspace store
 * refuses these names without a word; the field asks the same rule first
 * (describeWorkspacePathConflict) and says why, so it refuses exactly what the
 * store would.
 */
export function getInlineNameError(
  project: Pick<WorkspaceProject, "files" | "folders">,
  nextPath: string,
  options: { kind: SidebarEntryKind; currentPath?: string },
): string | null {
  if (!nextPath) {
    return "That name can't be used here.";
  }

  const refusal = describeWorkspacePathConflict(project, nextPath, options);
  if (!refusal) {
    return null;
  }

  switch (refusal.kind) {
    case "exists":
      return `"${getWorkspaceBaseName(nextPath)}" already exists here.`;
    case "inside-file":
      return `"${getWorkspaceBaseName(refusal.filePath)}" is a file, not a folder.`;
    case "inside-itself":
      return "A folder can't be moved inside itself.";
  }
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

export function buildWorkspaceTree(
  files: WorkspaceTreeFile[],
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
