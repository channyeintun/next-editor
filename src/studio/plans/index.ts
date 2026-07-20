import { parseStudioPlan, type StudioPlan } from "../plan";
import { M0_GO_HELLO_SLUG, createM0GoHelloPlan } from "./m0GoHello";
import goCubeCompiled from "./compiled/go-cube.json";

/**
 * Checked-in plans the studio route can render, by lesson slug: the M0
 * hard-coded fixture plus Director-compiled plans from `compiled/` (produced
 * by `bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml`).
 * Compiled JSON re-enters `parseStudioPlan` at load, so a stale or hand-edited
 * artifact fails here rather than mid-render.
 */
export const STUDIO_PLANS: Record<string, () => StudioPlan> = {
  [M0_GO_HELLO_SLUG]: createM0GoHelloPlan,
  "go-cube": () => parseStudioPlan(goCubeCompiled),
};

export const DEFAULT_STUDIO_PLAN_SLUG = M0_GO_HELLO_SLUG;
