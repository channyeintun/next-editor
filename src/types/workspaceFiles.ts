// What a workspace file is, judged from its path: the Monaco language it edits
// as, whether it is stored as bytes, and its MIME type and media kind.
import { getWorkspaceBaseName, normalizeWorkspacePath } from "./workspacePaths";

export function inferLanguageFromPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path).toLowerCase();

  if (
    normalizedPath.endsWith(".tsx") ||
    normalizedPath.endsWith(".ts") ||
    normalizedPath.endsWith(".mts") ||
    normalizedPath.endsWith(".cts")
  ) {
    return "typescript";
  }

  if (
    normalizedPath.endsWith(".jsx") ||
    normalizedPath.endsWith(".js") ||
    normalizedPath.endsWith(".mjs") ||
    normalizedPath.endsWith(".cjs")
  ) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
  }

  if (normalizedPath.endsWith(".go")) {
    return "go";
  }

  if (normalizedPath.endsWith(".kt") || normalizedPath.endsWith(".kts")) {
    return "kotlin";
  }

  if (normalizedPath.endsWith(".rs")) {
    return "rust";
  }

  // Registered by monaco/zigLanguage.ts — Monaco ships no Zig grammar.
  if (normalizedPath.endsWith(".zig") || normalizedPath.endsWith(".zon")) {
    return "zig";
  }

  // Registered by monaco/haskellLanguage.ts — Monaco ships no Haskell grammar
  // either. `.hs` only: `.lhs` is literate Haskell, a different format whose
  // source lines are the ones prefixed with `>`, and the playground compiles
  // plain Haskell — so treating an `.lhs` file as Haskell would colour the
  // prose as code and promise a run that upstream rejects.
  if (normalizedPath.endsWith(".hs")) {
    return "haskell";
  }

  // Registered by monaco/asmLanguage.ts. Monaco does ship an `asm` grammar, but
  // it is a generic one that highlights neither NASM's directives nor the
  // registers, which are most of what an assembly lesson points at.
  if (
    normalizedPath.endsWith(".asm") ||
    normalizedPath.endsWith(".s") ||
    normalizedPath.endsWith(".nasm")
  ) {
    return "asm";
  }

  // Registered by monaco/kiteLanguage.ts. This used to borrow Monaco's `rust`
  // grammar, which shares most of Kite's surface but leaves `var`, `check`,
  // `defer`, `nil` and `use` uncoloured, mis-reads `'a'` as a character
  // literal, and swallows `\(…)` interpolation holes into the string.
  if (normalizedPath.endsWith(".kite")) {
    return "kite";
  }

  if (normalizedPath.endsWith(".py")) {
    return "python";
  }

  if (normalizedPath.endsWith(".css")) {
    return "css";
  }

  if (normalizedPath.endsWith(".md")) {
    return "markdown";
  }

  if (normalizedPath.endsWith(".html")) {
    return "html";
  }

  // Monaco has no dedicated Vue/Svelte single-file-component mode; HTML gives
  // the closest highlighting for their template-heavy markup.
  if (normalizedPath.endsWith(".vue") || normalizedPath.endsWith(".svelte")) {
    return "html";
  }

  return "plaintext";
}

export function getWorkspaceFileExtension(path: string): string {
  const name = getWorkspaceBaseName(normalizeWorkspacePath(path)).toLowerCase();
  const dotIndex = name.lastIndexOf(".");

  return dotIndex > 0 ? name.slice(dotIndex + 1) : "";
}

// Extensions whose contents are not editable text and must be stored as bytes.
// SVG is intentionally absent: it is XML and stays editable as text.
const BINARY_WORKSPACE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "tiff",
  "tif",
  // Video
  "mp4",
  "webm",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "ogv",
  // Audio
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  // Fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // Other binary assets
  "pdf",
  "wasm",
  "zip",
  "gz",
  "tar",
  "bz2",
]);

const WORKSPACE_FILE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

/** True when a path points at a non-text asset that must be stored as bytes. */
export function isBinaryWorkspacePath(path: string): boolean {
  return BINARY_WORKSPACE_FILE_EXTENSIONS.has(getWorkspaceFileExtension(path));
}

export function getWorkspaceFileMimeType(path: string): string {
  // Object.hasOwn: the table is a plain object literal, so a file named
  // `x.constructor` resolved to an inherited function. That is non-nullish, so
  // `??` did not fire and a function was returned where a string is declared —
  // getWorkspaceMediaKind's `.startsWith` then threw mid-render.
  const extension = getWorkspaceFileExtension(path);
  return Object.hasOwn(WORKSPACE_FILE_MIME_TYPES, extension)
    ? WORKSPACE_FILE_MIME_TYPES[extension]
    : "application/octet-stream";
}

export type WorkspaceMediaKind = "image" | "video" | "audio" | "other";

export function getWorkspaceMediaKind(path: string): WorkspaceMediaKind {
  const mimeType = getWorkspaceFileMimeType(path);

  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  return "other";
}
