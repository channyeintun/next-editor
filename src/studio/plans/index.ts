import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { validateNarrationLanguage, type StudioNarrationLanguage } from "../narrationLanguage";
import { defaultRuntimeModeOf, type StudioRuntimeMode } from "../plan";
import { parseLessonScriptYaml } from "../script/parseYaml";
import type { LessonScript } from "../script/schema";
import {
  createPublishedScriptTexts,
  fetchPublishedScriptIndex,
  loadLatestPublishedScriptText,
  loadPublishedScriptText,
  type PublishedScriptTexts,
} from "./publishedScriptFetch";
import {
  WORKING_TREE_SOURCE,
  type PublishedScriptEntry,
  type PublishedScriptIndex,
} from "./publishedScripts";

/**
 * The lessons the studio can render, by slug. The scripts are not part of the
 * app: the studio reads the published index (scripts/lesson-scripts.ts puts
 * it; `bun run dev` serves one built from the folder) and fetches a script's
 * YAML only when a render or a narration pass needs it. YAML imported in the
 * studio joins them and shadows a published lesson of the same slug, so an
 * author can iterate on a lesson without publishing it. Parsing and
 * validation happen here in the browser, and the in-page Director compiles
 * the plan and synthesizes its narration at render time.
 *
 * Importable from Node as well (a tool needs parseLessonScriptYaml and the
 * default slugs): nothing here fetches or reads the query cache until the
 * hook runs.
 */
export interface StudioLessonSource {
  /** `lesson.title`; the slug for an imported script that does not parse. */
  title: string;
  /** `lesson.locale`, or null when it is not known without loading the script. */
  locale: string | null;
  /** The runtime mode a render defaults to, or null when it is not known without loading the script. */
  runtimeMode: StudioRuntimeMode | null;
  imported: boolean;
  /** The published script's id; null for an imported script. */
  id: string | null;
  /** Why the script cannot render, when that is known without loading it: an imported script that does not parse. */
  problem: string | null;
  /** The script, with the id of the published object it came from (null when imported). */
  load(options?: StudioLessonLoadOptions): Promise<{ id: string | null; script: LessonScript }>;
}

export interface StudioLessonLoadOptions {
  signal?: AbortSignal;
  /**
   * Ask for the index again first, so a page that stayed open performs the
   * script as it is published now, not as it was when the page read the
   * index. When that read fails, the script the page knows is loaded.
   */
  latest?: boolean;
}

export interface StudioLessons {
  /** "loading" until the published index has been read once, "error" when it could not be. */
  status: "loading" | "ready" | "error";
  /** Why the published index could not be read. */
  error: string | null;
  /**
   * What the index the page read was built from (a commit, or
   * WORKING_TREE_SOURCE under the dev server); null before it is read.
   */
  source: string | null;
  /** The published lessons and the imported ones, in a null-prototype record. */
  sources: Record<string, StudioLessonSource>;
}

export { parseLessonScriptYaml };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A published script this studio cannot parse was most likely written for
 * another version of the script schema: the scripts are published apart from
 * the code that reads them.
 */
function parsePublishedScript(slug: string, yamlText: string): LessonScript {
  try {
    return parseLessonScriptYaml(yamlText);
  } catch (error) {
    throw new Error(
      `The published lesson "${slug}" was published for a newer or older studio than this one: reload the page, or deploy the studio it needs. ${messageOf(error)}`,
    );
  }
}

function importedSourceOf(slug: string, yamlText: string): StudioLessonSource {
  const load = async () => ({ id: null, script: parseLessonScriptYaml(yamlText) });
  try {
    const script = parseLessonScriptYaml(yamlText);
    return {
      title: script.lesson.title,
      locale: script.lesson.locale,
      runtimeMode: defaultRuntimeModeOf(script.runtime),
      imported: true,
      id: null,
      problem: null,
      load,
    };
  } catch (error) {
    // Kept in the list, so the picker still offers it and Start can say why
    // it does not render (an import from before the schema last changed).
    return {
      title: slug,
      locale: null,
      runtimeMode: null,
      imported: true,
      id: null,
      problem: messageOf(error),
      load,
    };
  }
}

function publishedSourceOf(
  slug: string,
  entry: PublishedScriptEntry,
  texts: PublishedScriptTexts,
  refetchIndex: () => Promise<PublishedScriptIndex>,
): StudioLessonSource {
  return {
    title: entry.title,
    locale: entry.locale,
    runtimeMode: entry.runtimeMode,
    imported: false,
    id: entry.id,
    problem: null,
    load: async ({ signal, latest = false } = {}) => {
      const { id, text } = await (latest ? loadLatestPublishedScriptText : loadPublishedScriptText)(
        texts,
        slug,
        entry.id,
        refetchIndex,
        signal,
      );
      return { id, script: parsePublishedScript(slug, text) };
    },
  };
}

/**
 * The published lessons (none while the index is unread) plus the imported
 * ones, in a null-prototype record, so a `?plan=` of
 * `constructor`/`toString`/`__proto__` misses instead of resolving to an
 * inherited member: the callers' falsy guards let one through, and using it
 * once threw during render, outside any try/catch, dropping the whole /studio
 * route into its error boundary. An imported script replaces a published one
 * of the same slug.
 */
export function studioLessonSourcesOf(
  index: PublishedScriptIndex | undefined,
  imported: Readonly<Record<string, string>>,
  texts: PublishedScriptTexts,
  refetchIndex: () => Promise<PublishedScriptIndex>,
): Record<string, StudioLessonSource> {
  const record = Object.create(null) as Record<string, StudioLessonSource>;
  if (index) {
    for (const slug of Object.keys(index.lessons)) {
      record[slug] = publishedSourceOf(slug, index.lessons[slug], texts, refetchIndex);
    }
  }
  for (const slug of Object.keys(imported)) {
    record[slug] = importedSourceOf(slug, imported[slug]);
  }
  return record;
}

/**
 * The published index, read once per page for the lesson list. A render and
 * a narration pass read it again before they load a script (`latest`), and so
 * does a script that turns out to be missing; the list follows those reads.
 */
export function publishedScriptIndexQueryOptions() {
  return queryOptions({
    queryKey: ["studio", "published-script-index"] as const,
    queryFn: ({ signal }) => fetchPublishedScriptIndex(signal),
    staleTime: Infinity,
  });
}

/** Script texts for the life of the page, shared by every mount of the studio. */
const PUBLISHED_SCRIPT_TEXTS = createPublishedScriptTexts();

export function useStudioLessons(imported: Readonly<Record<string, string>>): StudioLessons {
  const queryClient = useQueryClient();
  const index = useQuery(publishedScriptIndexQueryOptions());
  const refetchIndex = () =>
    queryClient.fetchQuery({ ...publishedScriptIndexQueryOptions(), staleTime: 0 });
  const sources = studioLessonSourcesOf(index.data, imported, PUBLISHED_SCRIPT_TEXTS, refetchIndex);
  // A failed read after a successful one (the second look at the index)
  // keeps the lessons the first one listed.
  const status = index.data ? "ready" : index.isError ? "error" : "loading";
  return {
    status,
    error: index.error ? messageOf(index.error) : null,
    source: index.data?.source ?? null,
    sources,
  };
}

/**
 * Why `slug` is not in `lessons`, in words for the person who asked for it:
 * the index is still being read, could not be read, or does not name it.
 */
export function missingLessonReason(lessons: StudioLessons, slug: string): string {
  if (lessons.status === "loading") return "Reading the list of published lessons…";
  if (lessons.status === "error") {
    return `The published lessons could not be read, so "${slug}" is not available: ${lessons.error ?? "unknown error"} Reload to try again, or import the lesson's YAML.`;
  }
  const unknown = `Unknown lesson "${slug}": it is not published on this site and not imported.`;
  // The dev server builds its index from the folder and leaves a broken
  // script out of it, saying why only in its own terminal: point there, not
  // at publishing.
  return lessons.source === WORKING_TREE_SOURCE
    ? `${unknown} The dev server leaves out a script that does not parse or is not named ${slug}.yaml; its terminal says why.`
    : unknown;
}

/**
 * Whether the lesson `slug` can be narrated in `language`, from what the
 * lesson list knows without loading the script: it is listed, an imported
 * script parses, and its locale is one the narration speaks. The render, its
 * Start button and the workflow all ask this, so they refuse a lesson for the
 * same reason in the same words.
 */
export function lessonUsabilityOf(
  lessons: StudioLessons,
  slug: string,
  language: StudioNarrationLanguage,
): { source: StudioLessonSource } | { error: string } {
  const source = lessons.sources[slug];
  if (!source) return { error: missingLessonReason(lessons, slug) };
  if (source.problem) return { error: source.problem };
  // A locale the list does not know is checked once the script is loaded.
  const mismatch =
    source.locale === null ? null : validateNarrationLanguage(source.locale, language);
  return mismatch ? { error: mismatch } : { source };
}

/** The lesson Studio opens on when the URL names none. Burmese, like most of the courses. */
export const DEFAULT_STUDIO_PLAN_SLUG = "rust-borrow";

/**
 * The same for the English voice, which is what a first visit has: Start render
 * refuses a script the selected voice cannot speak, so the Burmese default
 * would open Studio on a disabled button. The shortest English lesson, to keep
 * a first render quick.
 */
export const DEFAULT_ENGLISH_STUDIO_PLAN_SLUG = "go-error-values";

/**
 * The default lesson of every narration language. Studio opens on one of
 * these, so a publish must not leave one out or publish it in another language.
 */
export const STUDIO_DEFAULT_LESSONS: readonly {
  language: StudioNarrationLanguage;
  slug: string;
}[] = [
  { language: "my", slug: DEFAULT_STUDIO_PLAN_SLUG },
  { language: "en", slug: DEFAULT_ENGLISH_STUDIO_PLAN_SLUG },
];

export function defaultStudioPlanSlugFor(language: StudioNarrationLanguage): string {
  return (
    STUDIO_DEFAULT_LESSONS.find((lesson) => lesson.language === language)?.slug ??
    DEFAULT_STUDIO_PLAN_SLUG
  );
}
