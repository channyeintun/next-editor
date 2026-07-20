import type { StudioPlan } from "../plan";
import { M0_GO_HELLO_SLUG, createM0GoHelloPlan } from "./m0GoHello";

/** Checked-in compiled plans the studio route can render, by lesson slug. */
export const STUDIO_PLANS: Record<string, () => StudioPlan> = {
  [M0_GO_HELLO_SLUG]: createM0GoHelloPlan,
};

export const DEFAULT_STUDIO_PLAN_SLUG = M0_GO_HELLO_SLUG;
