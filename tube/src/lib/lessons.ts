import axios from "axios";
import type { Lesson } from "../types";

export interface LessonsPage {
  lessons: Lesson[];
  /**
   * Opaque cursor for the next page, or null once exhausted. Namespaces which
   * backend serves it next — "seed:<n>" for a static build-time shard,
   * "d1:<n>" for a D1-backed page of user-published lessons — so the static
   * seed (introduction, etc.) is served first and pagination continues into
   * D1 once it's exhausted. See docs/cloudflare-architecture.md "Catalog
   * resolution".
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

// The Worker's SPA fallback (not_found_handling = "single-page-application",
// see infra/wrangler.toml) means an unmatched path is NEVER a real 404 — it's
// always a 200 carrying index.html. A seed shard that doesn't exist (any slug
// beyond what's in the static manifest) hits exactly this: is404() never
// fires because there's no error at all, so the raw HTML would otherwise be
// trusted as real JSON. Same fix useUrlLoader.ts already uses for the
// equivalent problem on the recording-proxy path — check Content-Type instead
// of trusting the status code alone.
function isHtmlFallback(res: { headers: Record<string, unknown> }): boolean {
  const contentType = res.headers["content-type"];
  return typeof contentType === "string" && contentType.includes("text/html");
}

function parseCursor(cursor: string): { source: "seed" | "d1"; index: number } {
  const [source, indexStr] = cursor.split(":");
  return { source: source === "d1" ? "d1" : "seed", index: Number(indexStr) || 0 };
}

// Static shard emitted by the lessonsApiPlugin Vite plugin (see vite.config.ts).
// Always has at least a page-0 (possibly empty), so this only 404s for an
// out-of-range index — treated as "no more seed pages" by the caller.
async function fetchSeedPage(index: number): Promise<RawLessonsPage | null> {
  try {
    const res = await axios.get<RawLessonsPage>(`/lessons/page-${index}.json`);
    if (isHtmlFallback(res)) return null;
    return res.data;
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}

// In production the Worker always matches /api/lessons* and returns real
// JSON, but plain `bun run dev` (no dev:worker) has no handler for it at
// all, so it falls through to the same SPA index.html fallback the seed
// path guards against above — same isHtmlFallback check, for symmetry and
// dev robustness.
async function fetchD1Page(index: number): Promise<RawLessonsPage> {
  const res = await axios.get<RawLessonsPage>(`/api/lessons?page=${index}`);
  if (isHtmlFallback(res)) return { lessons: [], nextPage: null };
  return res.data;
}

// Serves the static seed catalog first, then continues pagination into
// user-published D1 lessons once the seed is exhausted — the client only ever
// downloads the page it's showing, from whichever backend holds it.
export async function fetchLessonsPage(cursor: string): Promise<LessonsPage> {
  const { source, index } = parseCursor(cursor);

  if (source === "seed") {
    const page = await fetchSeedPage(index);
    if (page) {
      return {
        lessons: page.lessons,
        nextPage: page.nextPage !== null ? `seed:${page.nextPage}` : "d1:0",
      };
    }
    // No seed shard at this index at all — fall through to D1 from the start.
  }

  const page = await fetchD1Page(source === "d1" ? index : 0);
  return {
    lessons: page.lessons,
    nextPage: page.nextPage !== null ? `d1:${page.nextPage}` : null,
  };
}

// One request per lesson for the deep-linkable detail route — no catalog scan.
// Tries the static seed shard first, then the D1-backed API. Returns null (not
// undefined — Query rejects undefined) when the slug matches neither, so the
// route can tell "not found" from a real fetch failure.
export async function findLessonBySlug(slug: string): Promise<Lesson | null> {
  try {
    const res = await axios.get<Lesson>(`/lessons/by-slug/${encodeURIComponent(slug)}.json`);
    if (!isHtmlFallback(res)) return res.data;
    // Else: not a real shard for this slug — fall through to D1 below.
  } catch (err) {
    if (!is404(err)) throw err;
  }

  try {
    const res = await axios.get<Lesson>(`/api/lessons/${encodeURIComponent(slug)}`);
    // Same dev-without-worker fallback as fetchD1Page above: no real match.
    if (isHtmlFallback(res)) return null;
    return res.data;
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}
