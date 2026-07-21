import YAML from "yaml";
import type { StudioPlan } from "../plan";
import { parseLessonScript, type LessonScript } from "../script/schema";
import { M0_GO_HELLO_SLUG, createM0GoHelloPlan } from "./m0GoHello";

/**
 * Renderable lessons by slug. Two source kinds:
 * - "plan": a fully compiled plan with checked-in narration audio (the M0
 *   fixture) — rendered as-is.
 * - "script": a LessonScript YAML. The checked-in scripts under
 *   `src/studio/scripts/*.yaml` auto-register by filename via the glob below
 *   — authoring a new lesson never edits this file — and users can import
 *   additional YAML at runtime in the studio UI (see StudioController).
 *   Parsing and validation happen here in the browser; the Director CLI is
 *   optional preflight, not a build step.
 */
export type StudioLessonSource =
  | { kind: "plan"; load: () => StudioPlan }
  | { kind: "script"; load: () => LessonScript };

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
  [M0_GO_HELLO_SLUG]: { kind: "plan", load: createM0GoHelloPlan },
  ...scriptSources,
};

export const DEFAULT_STUDIO_PLAN_SLUG = M0_GO_HELLO_SLUG;

export function sourceRuntimeDefault(source: StudioLessonSource): "live" | "fixture" {
  const runtime = source.load().runtime;
  // Lessons without a runnable runtime execute fully locally; "fixture" is
  // the honest label for that.
  return runtime.kind === "none" ? "fixture" : runtime.defaultMode;
}

export function sourceTitle(source: StudioLessonSource): string {
  return source.load().lesson.title;
}
