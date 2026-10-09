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
export type StudioLessonSource = { kind: "script"; load: () => LessonScript };

const scriptYamls = import.meta.glob<string>("../scripts/*.yaml", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Parse + validate LessonScript YAML text (shared by the registry and the UI import). */
export function parseLessonScriptYaml(yamlText: string): LessonScript {
  return parseLessonScript(YAML.parse(yamlText));
}

const scriptSources: Record<string, StudioLessonSource> = {};
for (const [path, yamlText] of Object.entries(scriptYamls)) {
  const slug = path.replace(/^.*\//, "").replace(/\.ya?ml$/, "");
  scriptSources[slug] = { kind: "script", load: () => parseLessonScriptYaml(yamlText) };
}

export const STUDIO_SOURCES: Record<string, StudioLessonSource> = {
  ...scriptSources,
};

export const DEFAULT_STUDIO_PLAN_SLUG = "rust-borrow";
