import type { StudioPreviewCommandTarget } from "../utils/iframeStudioCommandBridge";
import type { StudioPlanAction, StudioPreviewTarget } from "./plan";

/**
 * How an authored preview target or expectation meets the preview bridge. The
 * expectation is judged twice — by the driver against the live inspection
 * while the render runs, and by QA against the checkpoint the recording
 * carries — and both judge it here, so the render can never pass live and fail
 * QA (or the reverse) because one side compared differently.
 */

/** What an expect.preview action asserts. */
export type PreviewExpectation = Pick<
  Extract<StudioPlanAction, { type: "expect.preview" }>,
  "route" | "textContains" | "value" | "attribute"
> & {
  /**
   * The element the observation must be of. Only QA passes it: the driver's
   * live inspection is of this element by construction (the bridge fails when
   * it is missing), so it never asks.
   */
  testId?: string;
};

/** What was observed: the driver's live inspection or QA's recorded checkpoint. */
export interface PreviewObservation {
  route: string;
  target?: {
    testId: string;
    text: string;
    value: string | null;
    attributes: Record<string, string>;
  };
}

/**
 * Every way `observed` falls short of `expected`, in a fixed order (route,
 * target element, text, value, attribute); empty when it matches.
 */
export function previewExpectationMismatches(
  expected: PreviewExpectation,
  observed: PreviewObservation,
): string[] {
  const { route, testId, textContains, value, attribute } = expected;
  const mismatches: string[] = [];
  if (route !== undefined && observed.route !== route) {
    mismatches.push(
      `route is ${JSON.stringify(observed.route)}, expected ${JSON.stringify(route)}`,
    );
  }
  if (testId !== undefined && observed.target?.testId !== testId) {
    mismatches.push(
      `target data-testid is ${JSON.stringify(observed.target?.testId)}, expected ${JSON.stringify(testId)}`,
    );
  }
  if (textContains !== undefined && !observed.target?.text.includes(textContains)) {
    mismatches.push(`target text does not contain ${JSON.stringify(textContains)}`);
  }
  if (value !== undefined && observed.target?.value !== value) {
    mismatches.push(
      `target value is ${JSON.stringify(observed.target?.value)}, expected ${JSON.stringify(value)}`,
    );
  }
  if (attribute !== undefined && observed.target?.attributes[attribute.name] !== attribute.value) {
    mismatches.push(
      `target attribute ${JSON.stringify(attribute.name)} is ${JSON.stringify(observed.target?.attributes[attribute.name])}, expected ${JSON.stringify(attribute.value)}`,
    );
  }
  return mismatches;
}

/** The bridge's target for an authored preview target (the bridge only knows test ids). */
export function previewCommandTarget(target: StudioPreviewTarget): StudioPreviewCommandTarget;
export function previewCommandTarget(
  target: StudioPreviewTarget | undefined,
): StudioPreviewCommandTarget | undefined;
export function previewCommandTarget(
  target: StudioPreviewTarget | undefined,
): StudioPreviewCommandTarget | undefined {
  return target ? { testId: target.value } : undefined;
}
