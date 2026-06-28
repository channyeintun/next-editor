import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export interface LessonsApiOptions {
  /** Absolute path to the authored manifest ({ lessons: Lesson[] }) to shard. */
  source: string;
  /** Lessons per page shard. Defaults to 12. */
  pageSize?: number;
}

interface LessonRecord {
  slug: string;
  [key: string]: unknown;
}

/**
 * Serves the /learn gallery's data as static, paginated shards so the client
 * only ever downloads the page it's scrolling (or the single lesson it opens),
 * never the whole catalog:
 *
 *   GET /lessons/page-<n>.json       → { lessons, nextPage }
 *   GET /lessons/by-slug/<slug>.json → Lesson
 *
 * Shards are produced from one authored manifest — re-read per request in dev
 * (so edits show on reload) and emitted as build assets — so dev and prod
 * resolve identical URLs. No `apply`: it's needed in both serve and build. Swap
 * point for a real backend: drop this plugin and point the client at
 * `/api/lessons?page=` / `/api/lessons/:slug`.
 */
export function lessonsApiPlugin({ source, pageSize = 12 }: LessonsApiOptions): Plugin {
  const pageRe = /^\/lessons\/page-(\d+)\.json$/;
  const slugRe = /^\/lessons\/by-slug\/(.+)\.json$/;

  const buildShards = (): { pages: string[]; bySlug: Map<string, string> } => {
    const parsed = JSON.parse(readFileSync(source, "utf8")) as { lessons?: LessonRecord[] };
    const lessons = parsed.lessons ?? [];
    const pageCount = Math.max(1, Math.ceil(lessons.length / pageSize));
    const pages: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      const start = i * pageSize;
      const slice = lessons.slice(start, start + pageSize);
      const nextPage = start + slice.length < lessons.length ? i + 1 : null;
      pages.push(JSON.stringify({ lessons: slice, nextPage }));
    }
    const bySlug = new Map<string, string>();
    for (const lesson of lessons) bySlug.set(lesson.slug, JSON.stringify(lesson));
    return { pages, bySlug };
  };

  return {
    name: "tube:lessons-api",
    // Default (pre) middleware: handle the shard endpoints before Vite's own
    // middlewares, so a missing shard returns a real 404 instead of the SPA
    // index.html fallback (which the client would fail to parse as JSON).
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        const pageMatch = pageRe.exec(path);
        const slugMatch = slugRe.exec(path);
        if (!pageMatch && !slugMatch) {
          next();
          return;
        }
        let body: string | undefined;
        try {
          // Re-read per request so editing the manifest shows up on reload.
          const { pages, bySlug } = buildShards();
          if (pageMatch) body = pages[Number(pageMatch[1])];
          else if (slugMatch) body = bySlug.get(decodeURIComponent(slugMatch[1]));
        } catch (error) {
          next(error);
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (body === undefined) {
          res.statusCode = 404;
          res.end(`{"error":"not found"}`);
          return;
        }
        res.end(body);
      });
    },
    // Emit the shards as build assets so Rollup writes them under the output dir
    // (and lists them in the build report) — no manual fs/mkdir.
    generateBundle() {
      const { pages, bySlug } = buildShards();
      pages.forEach((page, i) =>
        this.emitFile({ type: "asset", fileName: `lessons/page-${i}.json`, source: page }),
      );
      for (const [slug, lesson] of bySlug) {
        if (slug.includes("/")) continue;
        this.emitFile({ type: "asset", fileName: `lessons/by-slug/${slug}.json`, source: lesson });
      }
    },
  };
}
