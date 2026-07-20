import type { StudioPlan } from "../plan";
import { parseLessonScript, type LessonScript } from "../script/schema";
import { M0_GO_HELLO_SLUG, createM0GoHelloPlan } from "./m0GoHello";

/**
 * Renderable lessons by slug. Two source kinds:
 * - "plan": a fully compiled plan with checked-in narration audio (the M0
 *   fixture) — rendered as-is.
 * - "script": a validated LessonScript emitted by `scripts/studio-director.ts`
 *   into `./scripts/<slug>.json`. These auto-register by filename via the
 *   glob below — authoring a new lesson never edits this file (the agent
 *   workflow depends on that; see docs/lesson-script-authoring.md). Narration
 *   is synthesized per dialog in the page by the in-page Director
 *   (pocket-tts over onnxruntime-web), scheduled around the actions, and
 *   compiled just before recording.
 * Both re-enter their parser at load, so a stale artifact fails at render
 * time with a schema message rather than mid-performance.
 */
export type StudioLessonSource =
  | { kind: "plan"; load: () => StudioPlan }
  | { kind: "script"; load: () => LessonScript };

const emittedScripts = import.meta.glob<{ default: unknown }>("./scripts/*.json", {
  eager: true,
});

const scriptSources: Record<string, StudioLessonSource> = {};
for (const [path, module] of Object.entries(emittedScripts)) {
  if (path.endsWith(".critique.json")) {
    continue; // Advisory critic sidecars, not scripts.
  }
  const slug = path.replace(/^.*\//, "").replace(/\.json$/, "");
  scriptSources[slug] = { kind: "script", load: () => parseLessonScript(module.default) };
}

export const STUDIO_SOURCES: Record<string, StudioLessonSource> = {
  [M0_GO_HELLO_SLUG]: { kind: "plan", load: createM0GoHelloPlan },
  ...scriptSources,
};

export const DEFAULT_STUDIO_PLAN_SLUG = M0_GO_HELLO_SLUG;

export function sourceRuntimeDefault(source: StudioLessonSource): "live" | "fixture" {
  return source.load().runtime.defaultMode;
}

export function sourceTitle(source: StudioLessonSource): string {
  return source.load().lesson.title;
}
