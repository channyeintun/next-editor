/**
 * Published lessons from nexteditor.dev's public catalog: the list, one lesson by
 * slug, and its recording's bytes. Read-only GETs; no session.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SITE = "https://nexteditor.dev";

export interface ListedLesson {
  slug: string;
  /** The recording's path on the site, e.g. "media/lessons/<id>/<id>.ne". */
  ne: string;
  tags?: string[];
}

export type Fetch = (url: string) => Promise<Response>;

/** Lesson slugs are kebab-case words; anything else is refused before it reaches a URL. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A recording path the site serves: relative, under lessons/ or media/lessons/, a .ne. */
const RECORDING_PATH = /^(?:media\/)?lessons\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.ne$/;

export const isSlug = (slug: string) => SLUG.test(slug);

async function getJson(fetchUrl: Fetch, url: string): Promise<unknown> {
  const response = await fetchUrl(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

function toLesson(value: unknown): ListedLesson | null {
  if (typeof value !== "object" || value === null) return null;
  const { slug, ne, tags } = value as Record<string, unknown>;
  if (typeof slug !== "string" || !isSlug(slug)) return null;
  if (typeof ne !== "string" || ne.includes("..") || !RECORDING_PATH.test(ne)) return null;
  const tagList = Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : undefined;
  return { slug, ne, ...(tagList ? { tags: tagList } : {}) };
}

/** The newest `count` published lessons, newest first, page by page as the gallery reads them. */
export async function newestLessons(fetchUrl: Fetch, count: number): Promise<ListedLesson[]> {
  const lessons: ListedLesson[] = [];
  let page: number | null = 0;
  while (page !== null && lessons.length < count) {
    const body = (await getJson(fetchUrl, `${SITE}/api/lessons?page=${page}`)) as {
      lessons?: unknown[];
      nextPage?: unknown;
    };
    for (const each of body.lessons ?? []) {
      const lesson = toLesson(each);
      if (lesson && lessons.length < count) lessons.push(lesson);
    }
    page = typeof body.nextPage === "number" && body.nextPage > page ? body.nextPage : null;
  }
  return lessons;
}

/** One published lesson by its slug. */
export async function lessonBySlug(fetchUrl: Fetch, slug: string): Promise<ListedLesson> {
  if (!isSlug(slug)) throw new Error(`not a lesson slug: ${slug}`);
  const lesson = toLesson(await getJson(fetchUrl, `${SITE}/api/lessons/${slug}`));
  if (!lesson) throw new Error(`lesson ${slug} has no recording the site serves`);
  return lesson;
}

/** Downloads a lesson's recording into `folder`, as `<slug>.ne`. */
export async function downloadRecording(
  fetchUrl: Fetch,
  lesson: ListedLesson,
  folder: string,
): Promise<{ file: string; bytes: Uint8Array }> {
  const url = `${SITE}/${lesson.ne}`;
  const response = await fetchUrl(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const file = join(folder, `${lesson.slug}.ne`);
  await writeFile(file, bytes);
  return { file, bytes };
}

/** A human recording: one the studio did not produce. */
export const isHumanRecording = (lesson: ListedLesson) =>
  !(lesson.tags ?? []).some((tag) => tag === "studio" || tag === "ai-produced");
