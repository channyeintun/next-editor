import {
  collectWorkspaceFolders,
  DEFAULT_WORKSPACE_APP_PATH,
  type WorkspaceProject,
} from "../types/workspace";
import {
  createStarterWorkspacePackageJson,
  createWorkspaceFile,
  STARTER_FAVICON_SVG,
} from "./shared";

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
