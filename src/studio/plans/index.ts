import YAML from "yaml";
import { parseLessonScript, type LessonScript } from "../script/schema";

/**
 * Renderable lessons by slug, each a LessonScript YAML. The checked-in scripts
 * under `src/studio/scripts/*.yaml` auto-register by filename via the glob
 * below — authoring a new lesson never edits this file — and users can import
 * additional YAML at runtime in the studio UI (see StudioController). Parsing
 * and validation happen here in the browser, and the in-page Director compiles
 * the plan and synthesizes its narration at render time; the Director CLI is
 * optional preflight, not a build step.
 */
export type StudioLessonSource = { load: () => LessonScript };

// No `<string>` type argument on the call: Vitest's on-disk module cache keys a
// module on its own text and skips any module containing `import.meta.glob(`,
// whose expansion depends on the directory. The type argument hid the call from
// that check, so a cached copy kept the old lesson list after new YAML landed.
const scriptYamls: Record<string, string> = import.meta.glob("../scripts/*.yaml", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Parse + validate LessonScript YAML text (shared by the registry and the UI import). */
export function parseLessonScriptYaml(yamlText: string): LessonScript {
  return parseLessonScript(YAML.parse(yamlText));
}

/** The source of one LessonScript YAML text, checked in or imported. */
function scriptSourceOf(yamlText: string): StudioLessonSource {
  return { load: () => parseLessonScriptYaml(yamlText) };
}

/**
 * Sources by slug in a null-prototype record, so a `?plan=` of
 * `constructor`/`toString`/`__proto__` misses instead of resolving to an
 * inherited member: the callers' falsy guards let one through, and calling
 * `.load()` on it threw during render — outside any try/catch — dropping the
 * whole /studio route into its error boundary. A later entry replaces an
 * earlier one of the same slug.
 */
function sourceRecord(
  entries: Iterable<readonly [string, StudioLessonSource]>,
): Record<string, StudioLessonSource> {
  const record = Object.create(null) as Record<string, StudioLessonSource>;
  for (const [slug, source] of entries) {
    record[slug] = source;
  }
  return record;
}

export const STUDIO_SOURCES: Record<string, StudioLessonSource> = sourceRecord(
  Object.entries(scriptYamls).map(([path, yamlText]) => [
    path.replace(/^.*\//, "").replace(/\.ya?ml$/, ""),
    scriptSourceOf(yamlText),
  ]),
);

/**
 * The checked-in lessons plus the YAML imported in the studio (text by slug).
 * An imported script shadows a checked-in one of the same slug, so an author
 * can iterate on a lesson without editing the file.
 */
export function mergeStudioSources(
  imported: Readonly<Record<string, string>>,
): Record<string, StudioLessonSource> {
  return sourceRecord([
    ...Object.entries(STUDIO_SOURCES),
    ...Object.entries(imported).map(
      ([slug, yamlText]) => [slug, scriptSourceOf(yamlText)] as const,
    ),
  ]);
}

export const DEFAULT_STUDIO_PLAN_SLUG = "rust-borrow";
