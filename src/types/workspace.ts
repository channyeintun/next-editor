export type WorkspaceFileEncoding = "utf-8" | "base64";

export interface WorkspaceFile {
  path: string;
  name: string;
  language: string;
  content: string;
  /**
   * How `content` is encoded. Text files use "utf-8" (also the default when the
   * field is absent). Binary assets — images, video, audio, fonts, … — store
   * their bytes base64-encoded in `content` so the whole workspace stays
   * JSON-serializable for localStorage persistence and recordings, and so it
   * can travel through the same string-based file pipeline as text.
   */
  encoding?: WorkspaceFileEncoding;
}

export type WorkspaceLessonType =
  | "html-css"
  | "react"
  | "vue"
  | "solid"
  | "svelte"
  | "htmx-express";

/**
 * Every lesson type is served by its own dev server inside the WebContainer:
 * the Vite-based SPAs (react, vue, solid, svelte) and html-css run a Vite dev
 * server, while htmx-express runs an Express server. This predicate keeps the
 * runtime/preview code from special-casing individual lesson types, and is the
 * single place to update when new templates are added.
 */
const WEB_CONTAINER_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "html-css",
  "react",
  "vue",
  "solid",
  "svelte",
  "htmx-express",
]);

export function lessonRunsInWebContainer(lessonType: WorkspaceLessonType): boolean {
  return WEB_CONTAINER_LESSON_TYPES.has(lessonType);
}

export interface WorkspaceProject {
  id: string;
  name: string;
  lessonType: WorkspaceLessonType;
  entryFilePath: string;
  folders: string[];
  files: Record<string, WorkspaceFile>;
}

export interface WorkspaceRecordingSnapshot {
  project: WorkspaceProject;
  activeFilePath: string;
  collapsedFolders?: string[];
  sidebarScrollTop?: number;
  /** Width change since the previous recorded workspace event. */
  sidebarWidthDelta?: number;
}

export interface WorkspaceRecordingEvent {
  timestamp: number;
  snapshot: WorkspaceRecordingSnapshot;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areWorkspaceFilesEqual(
  left: Record<string, WorkspaceFile>,
  right: Record<string, WorkspaceFile>,
): boolean {
  const leftPaths = Object.keys(left).sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );
  const rightPaths = Object.keys(right).sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );

  if (!areStringArraysEqual(leftPaths, rightPaths)) {
    return false;
  }

  return leftPaths.every((path) => {
    const leftFile = left[path];
    const rightFile = right[path];

    return (
      leftFile.path === rightFile.path &&
      leftFile.name === rightFile.name &&
      leftFile.language === rightFile.language &&
      leftFile.content === rightFile.content &&
      (leftFile.encoding ?? "utf-8") === (rightFile.encoding ?? "utf-8")
    );
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function areWorkspaceSidebarDeltasEqual(
  left: WorkspaceRecordingSnapshot,
  right: WorkspaceRecordingSnapshot,
): boolean {
  const leftDelta = isFiniteNumber(left.sidebarWidthDelta) ? left.sidebarWidthDelta : 0;
  const rightDelta = isFiniteNumber(right.sidebarWidthDelta) ? right.sidebarWidthDelta : 0;

  return leftDelta === rightDelta;
}

export function areWorkspaceProjectsEqual(
  left: WorkspaceProject,
  right: WorkspaceProject,
): boolean {
  if (left === right) {
    return true;
  }

  return (
    left.id === right.id &&
    left.name === right.name &&
    left.lessonType === right.lessonType &&
    left.entryFilePath === right.entryFilePath &&
    areStringArraysEqual(left.folders, right.folders) &&
    areWorkspaceFilesEqual(left.files, right.files)
  );
}

export function areWorkspaceSnapshotsEqual(
  left: WorkspaceRecordingSnapshot,
  right: WorkspaceRecordingSnapshot,
): boolean {
  if (left === right) {
    return true;
  }

  return (
    left.activeFilePath === right.activeFilePath &&
    (left.sidebarScrollTop ?? 0) === (right.sidebarScrollTop ?? 0) &&
    areWorkspaceSidebarDeltasEqual(left, right) &&
    areStringArraysEqual(left.collapsedFolders ?? [], right.collapsedFolders ?? []) &&
    areWorkspaceProjectsEqual(left.project, right.project)
  );
}

export function toSidebarWidthDeltaSnapshot(
  snapshot: WorkspaceRecordingSnapshot,
  sidebarWidthDelta: number | undefined,
): WorkspaceRecordingSnapshot {
  if (!isFiniteNumber(sidebarWidthDelta)) {
    return snapshot;
  }

  return {
    ...snapshot,
    sidebarWidthDelta,
  };
}

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";
export const DEFAULT_WORKSPACE_APP_PATH = "src/App.tsx";

export function createHtmlCssLessonPackageJson(): string {
  return JSON.stringify(
    {
      name: "html-css-lesson",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0 --port 4173",
        build: "vite build",
        preview: "vite preview --host 0.0.0.0 --port 4173",
      },
      devDependencies: {
        vite: "^7.0.0",
      },
    },
    null,
    2,
  );
}

const STARTER_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="18" fill="#121826"/><path d="M20 44 30 20h4l10 24h-5.1l-2-5.2H27.1L25 44H20Zm8.6-9.3h6.8L32 25.6l-3.4 9.1Z" fill="#7dd3fc"/><path d="m41 19 4.6 8-4.6 8h-5.4l4.6-8-4.6-8H41Z" fill="#f59e0b"/></svg>`;

export function createStarterWorkspacePackageJson(projectName: string): string {
  const normalizedProjectName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return JSON.stringify(
    {
      name: normalizedProjectName || "next-editor-react-starter",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0 --port 4173",
        build: "tsgo -p tsconfig.json --noEmit && vite build",
        preview: "vite preview --host 0.0.0.0 --port 4173",
      },
      dependencies: {
        "@tanstack/react-query": "^5.101.0",
        "@tanstack/react-virtual": "^3.14.2",
        axios: "^1.13.2",
        react: "^19.2.5",
        "react-dom": "^19.2.5",
      },
      devDependencies: {
        "@typescript/native-preview": "7.0.0-dev.20260512.1",
        "@types/react": "^19.2.14",
        "@types/react-dom": "^19.2.3",
        "@vitejs/plugin-react": "^5.0.0",
        typescript: "~6.0.2",
        vite: "^7.0.0",
      },
    },
    null,
    2,
  );
}

export function normalizeWorkspacePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

export function normalizeWorkspaceFolderPath(path: string): string {
  return normalizeWorkspacePath(path).replace(/\/+$/, "");
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

export function inferLanguageFromPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path).toLowerCase();

  if (normalizedPath.endsWith(".tsx") || normalizedPath.endsWith(".ts")) {
    return "typescript";
  }

  if (normalizedPath.endsWith(".jsx") || normalizedPath.endsWith(".js")) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
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
  return WORKSPACE_FILE_MIME_TYPES[getWorkspaceFileExtension(path)] ?? "application/octet-stream";
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

/** Encode raw bytes as base64 in chunks so large assets don't overflow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/** Estimate the decoded byte length of base64 content without decoding it. */
export function approximateBase64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
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

function createWorkspaceFile(
  path: string,
  content: string,
  encoding?: WorkspaceFileEncoding,
): WorkspaceFile {
  const normalizedPath = normalizeWorkspacePath(path);

  return {
    path: normalizedPath,
    name: getWorkspaceBaseName(normalizedPath),
    language: inferLanguageFromPath(normalizedPath),
    content,
    ...(encoding && encoding !== "utf-8" ? { encoding } : {}),
  };
}

export function createStarterWorkspaceProject(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createStarterWorkspacePackageJson("next-editor-react-starter"),
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mastodon Trending Statuses Lesson</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
    ),
    "tsconfig.json": createWorkspaceFile(
      "tsconfig.json",
      `{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "lib": ["ES2023", "DOM"],
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}`,
    ),
    "vite.config.ts": createWorkspaceFile(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});`,
    ),
    "public/favicon.svg": createWorkspaceFile("public/favicon.svg", STARTER_FAVICON_SVG),
    "src/main.tsx": createWorkspaceFile(
      "src/main.tsx",
      `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);`,
    ),
    "src/constants.ts": createWorkspaceFile(
      "src/constants.ts",
      `export const DEFAULT_INSTANCE_URL = "https://mastodon.social";
export const PAGE_SIZE = 20;
export const TRENDING_STATUSES_ENDPOINT = "/api/v1/trends/statuses";
export const ESTIMATED_ROW_HEIGHT = 220;
export const VIRTUAL_ROW_OVERSCAN = 8;`,
    ),
    "src/types/mastodon.ts": createWorkspaceFile(
      "src/types/mastodon.ts",
      `export interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  url: string;
}

export interface MastodonStatus {
  id: string;
  created_at: string;
  content: string;
  url: string | null;
  replies_count: number;
  reblogs_count: number;
  favourites_count: number;
  account: MastodonAccount;
  reblog: MastodonStatus | null;
}

export interface TrendingStatusesPage {
  items: MastodonStatus[];
  nextOffset?: number;
}`,
    ),
    "src/api/mastodon.ts": createWorkspaceFile(
      "src/api/mastodon.ts",
      `import axios from "axios";
import { PAGE_SIZE, TRENDING_STATUSES_ENDPOINT } from "../constants.ts";
import { getNextOffsetFromLinkHeader } from "../utils/linkHeader.ts";
import type {
  MastodonStatus,
  TrendingStatusesPage,
} from "../types/mastodon.ts";

export async function fetchTrendingStatusesPage(
  instanceUrl: string,
  offset: number,
  signal?: AbortSignal,
): Promise<TrendingStatusesPage> {
  const url = new URL(TRENDING_STATUSES_ENDPOINT, instanceUrl);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));

  try {
    const response = await axios.get<MastodonStatus[]>(url.toString(), {
      signal,
      headers: {
        Accept: "application/json",
      },
    });
    const items = response.data;

    return {
      items,
      nextOffset: getNextOffsetFromLinkHeader(response.headers.link),
    };
  } catch (error) {
    if (axios.isCancel(error)) {
      throw error;
    }

    if (axios.isAxiosError<{ error?: string }>(error)) {
      const status = error.response?.status;
      const message =
        error.response?.data?.error ??
        (status
          ? "Trending request failed with " + status
          : "Trending request failed.");

      throw new Error(message);
    }

    throw error;
  }
}`,
    ),
    "src/utils/linkHeader.ts": createWorkspaceFile(
      "src/utils/linkHeader.ts",
      `function getHeaderText(header: unknown): string | undefined {
  if (typeof header === "string") {
    return header;
  }

  if (Array.isArray(header)) {
    return header.join(",");
  }

  return undefined;
}

export function getNextOffsetFromLinkHeader(
  linkHeader: unknown,
): number | undefined {
  const headerText = getHeaderText(linkHeader);

  if (!headerText) {
    return undefined;
  }

  const nextLink = headerText
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes('rel="next"'));
  const nextUrl = nextLink?.match(/<([^>]+)>/)?.[1];

  if (!nextUrl) {
    return undefined;
  }

  try {
    const parsedUrl = new URL(nextUrl);
    const nextOffset = Number(parsedUrl.searchParams.get("offset"));

    return Number.isFinite(nextOffset) ? nextOffset : undefined;
  } catch {
    return undefined;
  }
}`,
    ),
    "src/utils/formatting.ts": createWorkspaceFile(
      "src/utils/formatting.ts",
      `export function toPlainText(html: string): string {
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");

  return parsedDocument.body.textContent?.trim() ?? "";
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}`,
    ),
    "src/hooks/useTrendingStatuses.ts": createWorkspaceFile(
      "src/hooks/useTrendingStatuses.ts",
      `import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchTrendingStatusesPage } from "../api/mastodon.ts";

export function useTrendingStatuses(instanceUrl: string) {
  const query = useInfiniteQuery({
    queryKey: ["mastodon-trending-statuses", instanceUrl],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      fetchTrendingStatusesPage(instanceUrl, pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextOffset,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const statuses = query.data?.pages.flatMap((page) => page.items) ?? [];
  const errorMessage =
    query.error instanceof Error
      ? query.error.message
      : "The trending request failed.";

  return {
    errorMessage,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage ?? false,
    isError: query.isError,
    isFetchingNextPage: query.isFetchingNextPage,
    isPending: query.isPending,
    statuses,
  };
}`,
    ),
    "src/App.tsx": createWorkspaceFile(
      "src/App.tsx",
      `import { DEFAULT_INSTANCE_URL } from "./constants.ts";
import { TrendingStatusList } from "./components/TrendingStatusList.tsx";
import { useTrendingStatuses } from "./hooks/useTrendingStatuses.ts";
import "./App.css";

function App() {
  const timeline = useTrendingStatuses(DEFAULT_INSTANCE_URL);

  return (
    <main className="page">
      <TrendingStatusList
        errorMessage={timeline.errorMessage}
        hasNextPage={timeline.hasNextPage}
        isError={timeline.isError}
        isFetchingNextPage={timeline.isFetchingNextPage}
        isPending={timeline.isPending}
        onLoadMore={timeline.fetchNextPage}
        statuses={timeline.statuses}
      />
    </main>
  );
}

export default App;`,
    ),
    "src/components/EmptyState.tsx": createWorkspaceFile(
      "src/components/EmptyState.tsx",
      `import type { ReactNode } from "react";

interface EmptyStateProps {
  children: ReactNode;
  tone?: "default" | "error";
}

export function EmptyState({
  children,
  tone = "default",
}: EmptyStateProps) {
  const className =
    tone === "error" ? "empty-state error-state" : "empty-state";

  return (
    <div className={className}>
      <div className="empty-copy">{children}</div>
    </div>
  );
}`,
    ),
    "src/components/PostCard.tsx": createWorkspaceFile(
      "src/components/PostCard.tsx",
      `import type { MastodonStatus } from "../types/mastodon.ts";
import {
  formatCompactNumber,
  formatTimestamp,
  toPlainText,
} from "../utils/formatting.ts";

interface PostCardProps {
  status: MastodonStatus;
}

export function PostCard({ status }: PostCardProps) {
  const displayStatus = status.reblog ?? status;
  const author = displayStatus.account;
  const displayName = toPlainText(author.display_name) || author.username;
  const contentText =
    toPlainText(displayStatus.content) || "This post does not have text content.";

  return (
    <article className="post-card">
      <header className="post-header">
        <div className="post-author">
          <strong>{displayName}</strong>
          <span>@{author.acct}</span>
        </div>
        <a
          className="post-time"
          href={displayStatus.url ?? author.url}
          target="_blank"
          rel="noreferrer"
        >
          {formatTimestamp(displayStatus.created_at)}
        </a>
      </header>

      <p className="post-body">{contentText}</p>

      <footer className="post-stats">
        <span>{formatCompactNumber(displayStatus.replies_count)} replies</span>
        <span>{formatCompactNumber(displayStatus.reblogs_count)} boosts</span>
        <span>{formatCompactNumber(displayStatus.favourites_count)} favorites</span>
      </footer>
    </article>
  );
}`,
    ),
    "src/components/TrendingStatusList.tsx": createWorkspaceFile(
      "src/components/TrendingStatusList.tsx",
      `import { useEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  ESTIMATED_ROW_HEIGHT,
  VIRTUAL_ROW_OVERSCAN,
} from "../constants.ts";
import type { MastodonStatus } from "../types/mastodon.ts";
import { EmptyState } from "./EmptyState.tsx";
import { PostCard } from "./PostCard.tsx";

interface TrendingStatusListProps {
  statuses: MastodonStatus[];
  hasNextPage: boolean;
  isPending: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  errorMessage: string;
  onLoadMore: () => Promise<unknown>;
}

export function TrendingStatusList({
  statuses,
  hasNextPage,
  isPending,
  isError,
  isFetchingNextPage,
  errorMessage,
  onLoadMore,
}: TrendingStatusListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useEffect(() => {
    const updateScrollMargin = () => {
      setScrollMargin(containerRef.current?.offsetTop ?? 0);
    };

    updateScrollMargin();
    window.addEventListener("resize", updateScrollMargin);

    return () => window.removeEventListener("resize", updateScrollMargin);
  }, []);

  useEffect(() => {
    setScrollMargin(containerRef.current?.offsetTop ?? 0);
  }, [statuses.length, isError, isPending]);

  const virtualizer = useWindowVirtualizer({
    count: hasNextPage ? statuses.length + 1 : statuses.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: VIRTUAL_ROW_OVERSCAN,
    scrollMargin,
  });
  const virtualRows = virtualizer.getVirtualItems();

  useEffect(() => {
    const lastRow = virtualRows[virtualRows.length - 1];

    if (!lastRow) {
      return;
    }

    if (lastRow.index < statuses.length - 1) {
      return;
    }

    if (!hasNextPage || isFetchingNextPage) {
      return;
    }

    void onLoadMore();
  }, [
    virtualRows,
    statuses.length,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
  ]);

  if (isError) {
    return (
      <section className="timeline-shell" ref={containerRef}>
        <EmptyState tone="error">
          <p>{errorMessage}</p>
          <p>
            Some instances disable public trending data. Try another server if
            this one blocks the endpoint.
          </p>
        </EmptyState>
      </section>
    );
  }

  if (isPending && statuses.length === 0) {
    return (
      <section className="timeline-shell" ref={containerRef}>
        <EmptyState>
          <p>Loading the first page...</p>
        </EmptyState>
      </section>
    );
  }

  if (statuses.length === 0) {
    return (
      <section className="timeline-shell" ref={containerRef}>
        <EmptyState>
          <p>No trending posts are available for this instance right now.</p>
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="timeline-shell" ref={containerRef}>
      <div
        className="timeline"
        style={{ height: virtualizer.getTotalSize() + "px" }}
      >
        {virtualRows.map((virtualRow) => {
          const rowStyle = {
            transform:
              "translateY(" + (virtualRow.start - scrollMargin) + "px)",
          };

          if (virtualRow.index >= statuses.length) {
            return (
              <div
                key="loader-row"
                className="timeline-row loading-row"
                style={rowStyle}
              >
                Loading more trending posts...
              </div>
            );
          }

          const status = statuses[virtualRow.index];

          return (
            <div
              key={status.id}
              className="timeline-row"
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={rowStyle}
            >
              <PostCard status={status} />
            </div>
          );
        })}
      </div>
    </section>
  );
}`,
    ),
    "src/App.css": createWorkspaceFile(
      "src/App.css",
      `.page {
  width: min(100%, 46rem);
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 2rem) 0 4rem;
}
.post-time:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.empty-copy {
  display: grid;
  gap: 0.5rem;
}

.timeline-shell {
  position: relative;
  width: 100%;
  padding-inline: 1rem;
}

.timeline {
  position: relative;
  width: 100%;
}

.timeline-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  padding-bottom: 1rem;
}

.post-card {
  display: grid;
  gap: 0.85rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 1.25rem;
  background: var(--surface-elevated);
  box-shadow: var(--shadow-soft);
}

.post-header {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.75rem;
  align-items: start;
}

.post-author {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
}

.post-author strong {
  color: var(--text-strong);
  font-size: 0.98rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.post-author span,
.post-time {
  color: var(--text-muted);
  font-size: 0.86rem;
}

.post-time {
  text-decoration: none;
}

.post-time:hover {
  color: var(--accent);
}

.post-body {
  color: var(--text-strong);
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-line;
}

.post-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.empty-state,
.loading-row {
  display: grid;
  place-items: center;
  min-height: 6rem;
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 1.25rem;
  background: var(--surface);
  box-shadow: var(--shadow-soft);
  color: var(--text-muted);
  text-align: center;
}

.error-state {
  color: var(--danger);
}

@media (max-width: 768px) {
  .page {
    padding-top: 1rem;
  }

  .post-header {
    grid-template-columns: 1fr;
  }

  .post-time {
    justify-self: start;
  }
}`,
    ),
    "src/index.css": createWorkspaceFile(
      "src/index.css",
      `:root {
  --text: #425466;
  --text-strong: #122033;
  --text-muted: #64748b;
  --border: rgba(18, 32, 51, 0.12);
  --accent: #0f766e;
  --accent-strong: #115e59;
  --surface: rgba(255, 250, 242, 0.78);
  --surface-elevated: rgba(255, 255, 255, 0.88);
  --panel: linear-gradient(135deg, rgba(255, 255, 255, 0.88), rgba(255, 248, 235, 0.84));
  --chip: rgba(18, 32, 51, 0.06);
  --danger: #b91c1c;
  --shadow: 0 30px 80px -48px rgba(34, 47, 62, 0.55);
  --shadow-soft: 0 24px 48px -36px rgba(34, 47, 62, 0.45);
  font-family: "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
  line-height: 1.5;
  font-weight: 400;
  background:
    radial-gradient(circle at top left, rgba(15, 118, 110, 0.16), transparent 28%),
    radial-gradient(circle at top right, rgba(245, 158, 11, 0.18), transparent 22%),
    linear-gradient(180deg, #fcfbf7 0%, #f2ede2 100%);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #c3cfdd;
    --text-strong: #f5f7fb;
    --text-muted: #94a3b8;
    --border: rgba(195, 207, 221, 0.12);
    --accent: #5eead4;
    --accent-strong: #2dd4bf;
    --surface: rgba(11, 17, 32, 0.76);
    --surface-elevated: rgba(15, 23, 42, 0.86);
    --panel: linear-gradient(135deg, rgba(17, 24, 39, 0.92), rgba(11, 17, 32, 0.88));
    --chip: rgba(195, 207, 221, 0.08);
    --shadow: 0 30px 80px -48px rgba(2, 8, 23, 0.88);
    --shadow-soft: 0 24px 48px -36px rgba(2, 8, 23, 0.74);
    background:
      radial-gradient(circle at top left, rgba(45, 212, 191, 0.16), transparent 26%),
      radial-gradient(circle at top right, rgba(249, 115, 22, 0.16), transparent 24%),
      linear-gradient(180deg, #030712 0%, #111827 100%);
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  color: var(--text);
}

#root {
  min-height: 100svh;
}

a {
  color: inherit;
}

h1,
p {
  margin: 0;
}

h1 {
  color: var(--text-strong);
  font-size: clamp(2.8rem, 7vw, 5rem);
  letter-spacing: -0.06em;
  line-height: 0.96;
}

button,
input {
  font: inherit;
}

code {
  padding: 0.15rem 0.45rem;
  border-radius: 0.5rem;
  background: var(--chip);
  color: var(--text-strong);
}

img {
  max-width: 100%;
}`,
    ),
  };

  return {
    id: "starter-workspace",
    name: "Next Editor Trending Statuses",
    lessonType: "react",
    entryFilePath: DEFAULT_WORKSPACE_APP_PATH,
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

export function createStarterHtmlCssWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile("package.json", createHtmlCssLessonPackageJson()),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/styles.css" />
    <title>HTML/CSS Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>Hello world</h1>
      <p>Edit <code>index.html</code> and <code>styles.css</code> to get started.</p>
      <p><a href="/about.html">Go to the About page &rarr;</a></p>
    </main>
  </body>
</html>`,
    ),
    "about.html": createWorkspaceFile(
      "about.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/styles.css" />
    <title>About &middot; HTML/CSS Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>About</h1>
      <p>This page is served by Vite inside the WebContainer, so links between pages work.</p>
      <p><a href="/">&larr; Back home</a></p>
    </main>
  </body>
</html>`,
    ),
    "styles.css": createWorkspaceFile(
      "styles.css",
      `:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: 3rem 1.5rem;
  line-height: 1.6;
}

h1 {
  font-size: 2.5rem;
  margin: 0 0 0.75rem;
}

a {
  color: #2563eb;
}

code {
  padding: 0.1rem 0.35rem;
  border-radius: 0.35rem;
  background: rgba(127, 127, 127, 0.18);
}`,
    ),
  };

  return {
    id: "html-css-workspace",
    name: "HTML/CSS Lesson",
    lessonType: "html-css",
    entryFilePath: DEFAULT_WORKSPACE_ENTRY_PATH,
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

/**
 * Shared, editable page styles for the minimal framework starters so each
 * "hello world" lesson looks consistent while staying self-contained.
 */
function createMinimalLessonStyles(accentColor: string): string {
  return `:root {
  color-scheme: light dark;
  --accent: ${accentColor};
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: 3rem 1.5rem;
  line-height: 1.6;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 2.5rem;
}

code {
  padding: 0.1rem 0.35rem;
  border-radius: 0.35rem;
  background: rgba(127, 127, 127, 0.18);
}

button {
  margin-top: 1rem;
  padding: 0.55rem 1.1rem;
  font: inherit;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
}

button:hover {
  filter: brightness(1.05);
}
`;
}

function createViteSpaPackageJson(
  name: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string {
  return JSON.stringify(
    {
      name,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0 --port 4173",
        build: "vite build",
        preview: "vite preview --host 0.0.0.0 --port 4173",
      },
      dependencies,
      devDependencies: {
        vite: "^7.0.0",
        ...devDependencies,
      },
    },
    null,
    2,
  );
}

export function createStarterVueWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createViteSpaPackageJson("vue-lesson", { vue: "^3.5.0" }, { "@vitejs/plugin-vue": "^6.0.0" }),
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
});
`,
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vue Lesson</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    ),
    "src/main.js": createWorkspaceFile(
      "src/main.js",
      `import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");
`,
    ),
    "src/App.vue": createWorkspaceFile(
      "src/App.vue",
      `<script setup>
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main class="page">
    <h1>Hello Vue</h1>
    <p>Edit <code>src/App.vue</code> to get started.</p>
    <button type="button" @click="count++">Count is {{ count }}</button>
  </main>
</template>
`,
    ),
    "src/style.css": createWorkspaceFile("src/style.css", createMinimalLessonStyles("#42b883")),
  };

  return {
    id: "vue-workspace",
    name: "Vue Lesson",
    lessonType: "vue",
    entryFilePath: "src/App.vue",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

export function createStarterSolidWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createViteSpaPackageJson(
        "solid-lesson",
        { "solid-js": "^1.9.0" },
        { "vite-plugin-solid": "^2.11.0" },
      ),
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
});
`,
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Solid Lesson</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.jsx"></script>
  </body>
</html>
`,
    ),
    "src/index.jsx": createWorkspaceFile(
      "src/index.jsx",
      `import { render } from "solid-js/web";
import App from "./App.jsx";
import "./style.css";

render(() => <App />, document.getElementById("root"));
`,
    ),
    "src/App.jsx": createWorkspaceFile(
      "src/App.jsx",
      `import { createSignal } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main class="page">
      <h1>Hello Solid</h1>
      <p>Edit <code>src/App.jsx</code> to get started.</p>
      <button type="button" onClick={() => setCount(count() + 1)}>
        Count is {count()}
      </button>
    </main>
  );
}
`,
    ),
    "src/style.css": createWorkspaceFile("src/style.css", createMinimalLessonStyles("#2c4f7c")),
  };

  return {
    id: "solid-workspace",
    name: "Solid Lesson",
    lessonType: "solid",
    entryFilePath: "src/App.jsx",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

export function createStarterSvelteWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createViteSpaPackageJson(
        "svelte-lesson",
        {},
        { "@sveltejs/vite-plugin-svelte": "^6.0.0", svelte: "^5.0.0" },
      ),
    ),
    "svelte.config.js": createWorkspaceFile(
      "svelte.config.js",
      `import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
`,
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
});
`,
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Svelte Lesson</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    ),
    "src/main.js": createWorkspaceFile(
      "src/main.js",
      `import { mount } from "svelte";
import App from "./App.svelte";
import "./style.css";

const app = mount(App, { target: document.getElementById("app") });

export default app;
`,
    ),
    "src/App.svelte": createWorkspaceFile(
      "src/App.svelte",
      `<script>
  let count = $state(0);
</script>

<main class="page">
  <h1>Hello Svelte</h1>
  <p>Edit <code>src/App.svelte</code> to get started.</p>
  <button type="button" onclick={() => count++}>Count is {count}</button>
</main>
`,
    ),
    "src/style.css": createWorkspaceFile("src/style.css", createMinimalLessonStyles("#ff3e00")),
  };

  return {
    id: "svelte-workspace",
    name: "Svelte Lesson",
    lessonType: "svelte",
    entryFilePath: "src/App.svelte",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

export function createStarterHtmxExpressWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "htmx-express-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "node server.js",
            start: "node server.js",
          },
          dependencies: {
            express: "^5.1.0",
          },
        },
        null,
        2,
      ),
    ),
    "server.js": createWorkspaceFile(
      "server.js",
      `import express from "express";

const app = express();
const port = 3000;

// Serve the static HTML/CSS from the public/ folder.
app.use(express.static("public"));

// HTMX swaps this HTML fragment into the page when the button is clicked.
app.get("/api/time", (req, res) => {
  res.send(\`<p>Server time: \${new Date().toLocaleTimeString()}</p>\`);
});

app.listen(port, "0.0.0.0", () => {
  console.log(\`Server running on http://localhost:\${port}\`);
});
`,
    ),
    "public/index.html": createWorkspaceFile(
      "public/index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/styles.css" />
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <script>
      // The live preview injects a bootstrap <script> (declaring globals like
      // __WC_ENV__) into every HTML response, including the fragments htmx swaps
      // in. Re-executing it throws "Identifier '__WC_ENV__' has already been
      // declared", so tell htmx to leave scripts inside swapped content inert.
      htmx.config.allowScriptTags = false;
    </script>
    <title>HTMX + Express Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>Hello HTMX</h1>
      <p>This button asks the Express server for the current time.</p>
      <button type="button" hx-get="/api/time" hx-target="#result" hx-swap="innerHTML">
        Get server time
      </button>
      <div id="result"></div>
    </main>
  </body>
</html>
`,
    ),
    "public/styles.css": createWorkspaceFile(
      "public/styles.css",
      createMinimalLessonStyles("#3d72d7"),
    ),
  };

  return {
    id: "htmx-express-workspace",
    name: "HTMX + Express Lesson",
    lessonType: "htmx-express",
    entryFilePath: "public/index.html",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
