import type { StudioRuntimeMode } from "../plan";

/**
 * How the lesson scripts reach a studio that does not bundle them: the names
 * and shapes that the publisher (scripts/lesson-scripts.ts), the Worker route,
 * the dev server's stand-in for it, and the studio all agree on.
 *
 * A published script is the YAML file's bytes, stored under the SHA-256 of
 * those bytes and never rewritten. The index names, for every lesson, the
 * object that is its script today, plus the few facts the studio shows or
 * checks before it reads a script. Publishing puts the objects first and the
 * index last, so an index never names an object that is not there.
 *
 * Pure on purpose: no Node, no fetch, no schema. The Worker imports it, and
 * the only thing it takes from the studio is a type.
 */

/** Where the lesson scripts are kept, from the repository's root. Text only: resolve it with scripts/lessonScriptsDir.ts. */
export const LESSON_SCRIPTS_FOLDER = "src/studio/scripts";

export const PUBLISHED_SCRIPTS_PATH = "/api/studio/scripts";
export const PUBLISHED_SCRIPT_INDEX_PATH = `${PUBLISHED_SCRIPTS_PATH}/index`;
const PUBLISHED_SCRIPT_OBJECTS_PATH = `${PUBLISHED_SCRIPTS_PATH}/objects/`;

/** The bucket prefix. It is served only by the studio scripts route, never by /media. */
export const PUBLISHED_SCRIPTS_KEY_PREFIX = "studio-scripts/";
export const PUBLISHED_SCRIPT_INDEX_KEY = `${PUBLISHED_SCRIPTS_KEY_PREFIX}index.json`;

export const PUBLISHED_SCRIPT_CONTENT_TYPE = "text/plain; charset=utf-8";
export const PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE = "application/json";

const PUBLISHED_SCRIPT_ID = /^[0-9a-f]{64}$/;

/** A script's id: the lowercase hex SHA-256 of its YAML bytes. */
export function isPublishedScriptId(value: unknown): value is string {
  return typeof value === "string" && PUBLISHED_SCRIPT_ID.test(value);
}

export function publishedScriptObjectPath(id: string): string {
  return `${PUBLISHED_SCRIPT_OBJECTS_PATH}${id}`;
}

/** The id a request path under the objects prefix names, or null when it is not one. */
export function publishedScriptIdOfPath(pathname: string): string | null {
  if (!pathname.startsWith(PUBLISHED_SCRIPT_OBJECTS_PATH)) return null;
  const id = pathname.slice(PUBLISHED_SCRIPT_OBJECTS_PATH.length);
  return isPublishedScriptId(id) ? id : null;
}

export function publishedScriptObjectKey(id: string): string {
  return `${PUBLISHED_SCRIPTS_KEY_PREFIX}objects/${id}`;
}

export const PUBLISHED_SCRIPT_INDEX_VERSION = 1;

/** What the studio knows about a lesson before it reads the script. */
export interface PublishedScriptEntry {
  /** The script's id, and so the object that holds it. */
  id: string;
  /** The size of the YAML in bytes. */
  bytes: number;
  /** `lesson.title`. */
  title: string;
  /** `lesson.locale`, checked against the narration voice before a render starts. */
  locale: string;
  /** The mode a render uses when the URL does not choose one (`defaultRuntimeModeOf`). */
  runtimeMode: StudioRuntimeMode;
}

export interface PublishedScriptIndex {
  version: typeof PUBLISHED_SCRIPT_INDEX_VERSION;
  /**
   * What the index was built from: the commit a publish read the scripts from,
   * or `WORKING_TREE_SOURCE` for the dev server's own index.
   */
  source: string;
  /**
   * Entries by lesson slug, in a null-prototype record: a slug of
   * `constructor` or `__proto__` misses instead of finding an inherited member.
   */
  lessons: Record<string, PublishedScriptEntry>;
}

export const WORKING_TREE_SOURCE = "working-tree";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryOf(slug: string, value: unknown): PublishedScriptEntry {
  const fail = (what: string): never => {
    throw new Error(`The lesson index is not valid: "${slug}" ${what}`);
  };
  if (!isRecord(value)) return fail("is not an entry");
  const { id, bytes, title, locale, runtimeMode } = value;
  if (!isPublishedScriptId(id)) return fail("has no script id");
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    return fail("has no size");
  }
  if (typeof title !== "string" || title === "") return fail("has no title");
  if (typeof locale !== "string" || locale === "") return fail("has no locale");
  if (runtimeMode !== "live" && runtimeMode !== "fixture") return fail("has no runtime mode");
  return { id, bytes, title, locale, runtimeMode };
}

/** Check a decoded index and rebuild it with a null-prototype `lessons` record. Throws on anything else. */
export function parsePublishedScriptIndex(value: unknown): PublishedScriptIndex {
  if (!isRecord(value)) throw new Error("The lesson index is not valid: it is not an object");
  if (value.version !== PUBLISHED_SCRIPT_INDEX_VERSION) {
    throw new Error(
      `The lesson index has version ${String(value.version)}; this studio reads version ${PUBLISHED_SCRIPT_INDEX_VERSION}`,
    );
  }
  if (typeof value.source !== "string" || value.source === "") {
    throw new Error("The lesson index is not valid: it does not say what it was built from");
  }
  if (!isRecord(value.lessons)) {
    throw new Error("The lesson index is not valid: it has no lessons");
  }
  const lessons = Object.create(null) as Record<string, PublishedScriptEntry>;
  for (const slug of Object.keys(value.lessons)) {
    if (slug === "") throw new Error("The lesson index is not valid: a lesson has no slug");
    lessons[slug] = entryOf(slug, value.lessons[slug]);
  }
  return { version: PUBLISHED_SCRIPT_INDEX_VERSION, source: value.source, lessons };
}

/**
 * The index as the bytes that are stored: slugs in order and one fixed key
 * order, so the same lessons always give the same text.
 */
export function encodePublishedScriptIndex(index: PublishedScriptIndex): string {
  const lessons: Record<string, PublishedScriptEntry> = {};
  for (const slug of Object.keys(index.lessons).sort()) {
    const { id, bytes, title, locale, runtimeMode } = index.lessons[slug];
    lessons[slug] = { id, bytes, title, locale, runtimeMode };
  }
  return `${JSON.stringify({ version: index.version, source: index.source, lessons })}\n`;
}
