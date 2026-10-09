// Workspace paths: parsing user, import and runtime supplied paths into one
// canonical, safe workspace-relative form, and building paths from it.

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";
export const DEFAULT_WORKSPACE_APP_PATH = "src/App.tsx";

const RESERVED_WORKSPACE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function containsWorkspacePathControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export class WorkspacePathError extends Error {
  readonly input: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.input = input;
  }
}

interface ParseWorkspacePathOptions {
  allowEmpty?: boolean;
}

/**
 * Parse a user/import/runtime supplied path into one canonical workspace-relative path.
 *
 * Leading separators are treated as workspace-root-relative for backwards compatibility.
 * Dot segments are resolved, while traversal above the workspace root, control characters,
 * and names that are unsafe as JavaScript record keys are rejected.
 */
export function parseWorkspacePath(
  path: string,
  { allowEmpty = false }: ParseWorkspacePathOptions = {},
): string {
  if (typeof path !== "string") {
    throw new WorkspacePathError("Workspace path must be a string", String(path));
  }

  const input = path;
  const normalizedSeparators = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");

  // Repeated separators inside a path are canonicalized, but a trailing
  // separator would otherwise turn an empty terminal filename into its parent
  // directory (for example, "src/App.tsx/" -> "src/App.tsx"). Keep the empty
  // workspace root as the sole exception for callers that explicitly allow it.
  if (normalizedSeparators.length > 0 && normalizedSeparators.endsWith("/")) {
    throw new WorkspacePathError("Workspace path has an empty terminal name", input);
  }
  const segments: string[] = [];

  for (const segment of normalizedSeparators.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        throw new WorkspacePathError("Workspace path escapes the project root", input);
      }
      segments.pop();
      continue;
    }

    if (containsWorkspacePathControlCharacter(segment)) {
      throw new WorkspacePathError("Workspace path contains a control character", input);
    }

    if (RESERVED_WORKSPACE_PATH_SEGMENTS.has(segment)) {
      throw new WorkspacePathError(`Workspace path uses the reserved name "${segment}"`, input);
    }

    segments.push(segment);
  }

  const normalizedPath = segments.join("/");

  if (!normalizedPath && !allowEmpty) {
    throw new WorkspacePathError("Workspace path cannot be empty", input);
  }

  return normalizedPath;
}

export function tryParseWorkspacePath(
  path: string,
  options: ParseWorkspacePathOptions = {},
): string | null {
  try {
    return parseWorkspacePath(path, options);
  } catch {
    return null;
  }
}

export function normalizeWorkspacePath(path: string): string {
  return tryParseWorkspacePath(path, { allowEmpty: true }) ?? "";
}

export function normalizeWorkspaceFolderPath(path: string): string {
  return normalizeWorkspacePath(path);
}

export function getWorkspaceBaseName(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] || normalizedPath;
}

export function getParentWorkspacePath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const segments = normalizedPath.split("/");
  segments.pop();
  return segments.join("/");
}

export function joinWorkspacePath(parentPath: string, name: string): string {
  const normalizedParentPath = normalizeWorkspaceFolderPath(parentPath);
  const normalizedName = normalizeWorkspacePath(name);

  if (!normalizedName) {
    return "";
  }

  if (!normalizedParentPath) {
    return normalizedName;
  }

  return normalizeWorkspacePath(`${normalizedParentPath}/${normalizedName}`);
}

export function collectWorkspaceFolders(
  filePaths: string[],
  extraFolders: string[] = [],
): string[] {
  const folders = new Set<string>();

  const addFolderPath = (folderPath: string) => {
    let currentPath = normalizeWorkspaceFolderPath(folderPath);

    while (currentPath) {
      folders.add(currentPath);
      currentPath = getParentWorkspacePath(currentPath);
    }
  };

  for (const folderPath of extraFolders) {
    addFolderPath(folderPath);
  }

  for (const filePath of filePaths) {
    addFolderPath(getParentWorkspacePath(filePath));
  }

  return Array.from(folders).sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve a non-colliding workspace path by appending `-1`, `-2`, … before the
 * extension. Used when importing assets so re-uploading never clobbers a file.
 */
export function getUniqueWorkspacePath(
  desiredPath: string,
  isTaken: (path: string) => boolean,
): string {
  const normalizedPath = normalizeWorkspacePath(desiredPath);

  if (!isTaken(normalizedPath)) {
    return normalizedPath;
  }

  const parentPath = getParentWorkspacePath(normalizedPath);
  const baseName = getWorkspaceBaseName(normalizedPath);
  const dotIndex = baseName.lastIndexOf(".");
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const extension = dotIndex > 0 ? baseName.slice(dotIndex) : "";

  let counter = 1;
  let candidate = joinWorkspacePath(parentPath, `${stem}-${counter}${extension}`);

  while (isTaken(candidate)) {
    counter += 1;
    candidate = joinWorkspacePath(parentPath, `${stem}-${counter}${extension}`);
  }

  return candidate;
}
