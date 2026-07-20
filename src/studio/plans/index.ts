import type { StudioPlan } from "../plan";
import { parseLessonScript, type LessonScript } from "../script/schema";
import { M0_GO_HELLO_SLUG, createM0GoHelloPlan } from "./m0GoHello";
import goCubeScript from "./scripts/go-cube.json";
import goCubeTourScript from "./scripts/go-cube-tour.json";
import goSwapScript from "./scripts/go-swap.json";

/**
 * Renderable lessons by slug. Two source kinds:
 * - "plan": a fully compiled plan with checked-in narration audio (the M0
 *   fixture) — rendered as-is.
 * - "script": a validated LessonScript (emitted by `scripts/studio-director.ts`
 *   from the YAML source); narration is synthesized per dialog in the page by
 *   the in-page Director (pocket-tts over onnxruntime-web), scheduled around the
 *   actions, and compiled just before recording.
 * Both re-enter their parser at load, so a stale artifact fails here rather
 * than mid-render.
 */
export type StudioLessonSource =
  | { kind: "plan"; load: () => StudioPlan }
  | { kind: "script"; load: () => LessonScript };

export const STUDIO_SOURCES: Record<string, StudioLessonSource> = {
  [M0_GO_HELLO_SLUG]: { kind: "plan", load: createM0GoHelloPlan },
  "go-cube": { kind: "script", load: () => parseLessonScript(goCubeScript) },
  "go-cube-tour": { kind: "script", load: () => parseLessonScript(goCubeTourScript) },
  "go-swap": { kind: "script", load: () => parseLessonScript(goSwapScript) },
};

export const DEFAULT_STUDIO_PLAN_SLUG = M0_GO_HELLO_SLUG;

export function sourceRuntimeDefault(source: StudioLessonSource): "live" | "fixture" {
  return source.load().runtime.defaultMode;
}

export function sourceTitle(source: StudioLessonSource): string {
  return source.load().lesson.title;
}
