// Workspace paths: parsing user, import and runtime supplied paths into one
// canonical, safe workspace-relative form, and building paths from it.

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";

// The one "unsafe as a record key" rule: every Object.prototype member name
// (constructor, __proto__, toString, valueOf, hasOwnProperty, ...) plus
// "prototype". project.files is a plain object, so any of these as a path
// would look up an inherited member instead of a missing file.
const RESERVED_WORKSPACE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype),
]);

/** A name unsafe as a JavaScript record key, which no path segment may use. */
export function isReservedWorkspacePathSegment(segment: string): boolean {
  return RESERVED_WORKSPACE_PATH_SEGMENTS.has(segment);
}

/** A control character, which no path segment may contain. */
export function isWorkspacePathControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
}

// By code unit, allocating nothing: every control character is a single unit, and
// the ancestor walks parse the same path once per level.
function containsWorkspacePathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

/**
 * Upper bounds on one workspace path, enforced by {@link parseWorkspacePath} so
 * that every producer of paths is held to them: a zip import, a recording's
 * workspace snapshots, a restored project, a runtime file event.
 *
 * A path costs only its own length wherever it comes from, so `a/a/…/a/f` at
 * depth 16,000 fits in a few hundred deflated bytes of a zip or a `.ne` file.
 * Everything that walks a path's ancestors (the folder list, the
 * file-versus-directory checks) then does work quadratic in its depth, and keeps
 * every ancestor prefix: one such path froze the tab for seconds, and a deeper
 * one exhausted its memory. No real project comes anywhere near either bound
 * (Windows' own MAX_PATH is 260).
 */
export const MAX_WORKSPACE_PATH_CHARS = 4096;
export const MAX_WORKSPACE_PATH_DEPTH = 64;

/** How much of an over-long path an error keeps, so the error is not over-long too. */
const QUOTED_PATH_CHARS = 80;

export class WorkspacePathError extends Error {
  readonly input: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.input = input;
  }
}

/** A path longer or deeper than any workspace path may be. */
export class WorkspacePathLimitError extends WorkspacePathError {
  constructor(message: string, input: string) {
    super(message, input.slice(0, QUOTED_PATH_CHARS));
    this.name = "WorkspacePathLimitError";
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
 * names that are unsafe as JavaScript record keys, and paths past the length and depth
 * bounds are rejected.
 */
export function parseWorkspacePath(
  path: string,
  { allowEmpty = false }: ParseWorkspacePathOptions = {},
): string {
  if (typeof path !== "string") {
    throw new WorkspacePathError("Workspace path must be a string", String(path));
  }

  const input = path;
  // Checked on the raw path, before any work proportional to its length.
  if (input.length > MAX_WORKSPACE_PATH_CHARS) {
    throw new WorkspacePathLimitError(
      `Workspace path is longer than ${MAX_WORKSPACE_PATH_CHARS} characters`,
      input,
    );
  }
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

    if (isReservedWorkspacePathSegment(segment)) {
      throw new WorkspacePathError(`Workspace path uses the reserved name "${segment}"`, input);
    }

    segments.push(segment);
    if (segments.length > MAX_WORKSPACE_PATH_DEPTH) {
      throw new WorkspacePathLimitError(
        `Workspace path is nested deeper than ${MAX_WORKSPACE_PATH_DEPTH} levels`,
        input,
      );
    }
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

/** The text before a canonical path's last separator: its parent, or "" at the root. */
function parentOfCanonicalPath(canonicalPath: string): string {
  return canonicalPath.slice(0, Math.max(0, canonicalPath.lastIndexOf("/")));
}

export function getParentWorkspacePath(path: string): string {
  return parentOfCanonicalPath(normalizeWorkspacePath(path));
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

    // The path is canonical from here on, so its parent is the text before its last
    // separator, and a folder already collected brought every ancestor with it.
    while (currentPath && !folders.has(currentPath)) {
      folders.add(currentPath);
      currentPath = parentOfCanonicalPath(currentPath);
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
