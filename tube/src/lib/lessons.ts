import axios from "axios";
import type { Lesson } from "../types";
import lessonsData from "../../data/lessons.json";

export interface LessonsPage {
  lessons: Lesson[];
  /**
   * Opaque cursor for the next page, or null once exhausted: "d1:<n>" for the
   * n-th D1-backed page of user-published lessons, newest first. The bundled
   * seed (introduction, etc.) has no page of its own; it rides on the last D1
   * page (see fetchLessonsPage and docs/cloudflare-architecture.md "Catalog
   * resolution").
   */
  nextPage: string | null;
}

interface RawLessonsPage {
  lessons: Lesson[];
  nextPage: number | null;
}

function is404(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

// axios has no timeout by default and nothing in tube configures one, so a
// request that is accepted and then never answered (a stalled mobile
// connection, a proxy holding the socket) never settles: Query's retry never
// fires and the grid sits in isFetchingNextPage forever, showing a trailing
// row of skeletons with no "Load more" and no error row to retry from. Failing
// after a bounded wait puts the stall back into the retry/error UI that
// already exists. Generous, since these are cache-backed JSON reads and a slow
// answer is still better than a spurious failure.
const REQUEST_TIMEOUT_MS = 15_000;

// The Worker's SPA fallback (not_found_handling = "single-page-application",
// see infra/wrangler.toml) means an unmatched path is NEVER a real 404 — it's
// always a 200 carrying index.html. A seed shard that doesn't exist (any slug
// beyond what's in the static manifest) hits exactly this: is404() never
// fires because there's no error at all, so the raw HTML would otherwise be
// trusted as real JSON. Same fix src/storage/recordingFetch.ts already uses for the
// equivalent problem on the recording-proxy path — check Content-Type instead
// of trusting the status code alone.
function isHtmlFallback(res: { headers: Record<string, unknown> }): boolean {
  const contentType = res.headers["content-type"];
  return typeof contentType === "string" && contentType.includes("text/html");
}

const SEED_LESSONS = lessonsData.lessons as Lesson[];

// The D1 page a cursor names. Anything that isn't a "d1:<n>" cursor starts
// from the first page.
function d1PageIndex(cursor: string): number {
  const [source, indexStr] = cursor.split(":");
  return source === "d1" ? Number(indexStr) || 0 : 0;
}

// The Worker always answers /api/lessons* with JSON. A host without it (a
// static preview of the build) would answer with the SPA's index.html instead,
// which is read as an empty last page, so the gallery shows just the seed.
// Plain `bun run dev` is different: Vite proxies /api/lessons to the Worker on
// :8787 (vite.config.ts), so without `dev:worker` page 0 fails with a 502 and
// the gallery shows its error and a retry button.
async function fetchD1Page(index: number): Promise<RawLessonsPage> {
  const res = await axios.get<RawLessonsPage>(`/api/lessons?page=${index}`, {
    timeout: REQUEST_TIMEOUT_MS,
  });
  if (isHtmlFallback(res)) return { lessons: [], nextPage: null };
  return res.data;
}

// Pages through user-published D1 lessons, newest first. The bundled seed
// (introduction) is appended to the last D1 page, so it appears only once the
// gallery has loaded its oldest lessons. That normally takes scrolling to the
// end; but the grid's sentinel loads ahead by 400px, so a catalog of one or two
// pages on a tall window can reach its last page, and the seed, without any
// scroll. An empty catalog's only page is that last page, so the seed still
// shows there.
export async function fetchLessonsPage(cursor: string): Promise<LessonsPage> {
  const page = await fetchD1Page(d1PageIndex(cursor));
  if (page.nextPage !== null) {
    return { lessons: page.lessons, nextPage: `d1:${page.nextPage}` };
  }
  return { lessons: [...page.lessons, ...SEED_LESSONS], nextPage: null };
}

/**
 * Flatten the loaded pages into the list the grid renders, keeping the first
 * occurrence of each slug.
 *
 * The ordering fix in listPublishedLessons (a total order, so tied
 * `published_at` values cannot straddle a page boundary) removes the cause
 * this was written for. It stays because OFFSET paging is racy for a reason
 * no ORDER BY can fix: pages are fetched as separate requests, minutes apart,
 * and routes/lessons.ts caches each page independently for 60s. If a lesson is
 * published between two of those fetches, every later row shifts down one and
 * the boundary row is genuinely returned twice.
 *
 * It also covers the D1→seed seam on the last page, where a slug present in
 * both catalogs would otherwise be rendered twice.
 *
 * Deduping is the right response rather than a cosmetic patch: React keys the
 * cards by slug, so a repeat is a duplicate key, not just a repeated picture.
 */
export function flattenLessonPages(pages: readonly LessonsPage[] | undefined): Lesson[] {
  const seen = new Set<string>();
  const lessons: Lesson[] = [];
  for (const page of pages ?? []) {
    for (const lesson of page.lessons) {
      if (seen.has(lesson.slug)) continue;
      seen.add(lesson.slug);
      lessons.push(lesson);
    }
  }
  return lessons;
}

// One request per lesson for the deep-linkable detail route — no catalog scan.
// Tries the static seed shard first, then the D1-backed API. Returns null (not
// undefined — Query rejects undefined) when the slug matches neither, so the
// route can tell "not found" from a real fetch failure.
export async function findLessonBySlug(slug: string): Promise<Lesson | null> {
  const seedLesson = SEED_LESSONS.find((l) => l.slug === slug);
  if (seedLesson) {
    return seedLesson as Lesson;
  }

  try {
    const res = await axios.get<Lesson>(`/api/lessons/${encodeURIComponent(slug)}`, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    // Same dev-without-worker fallback as fetchD1Page above: no real match.
    if (isHtmlFallback(res)) return null;
    return res.data;
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}
