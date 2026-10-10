import type { Recording } from "../core/src";
import type { RuntimeRecordingSnapshot } from "../core/src/runtime";
import type { StudioPlan } from "./plan";
import { PREVIEW_ERROR_LINE } from "./qaPreview";
import { workspaceTextFilesOf } from "./recordingWorkspace";
import type { StudioCheckResult } from "./report";

/**
 * The runtime gates of the artifact QA (qa.ts): no runtime or error-tagged
 * console failure, and each expect.output / expect.file checkpoint, re-checked
 * against the *encoded* recording.
 */

/**
 * A console line a runner or a formatter wrote to report a failure:
 * `[<lang>-run error]`, `[<lang>-fmt error]`, `[rustfmt error]`, …. Program
 * output is recorded unprefixed, so the tag has to open the line and be one of
 * those shapes — a bare "error]" anywhere also matched a program's own output,
 * since fmt.Println of an []error prints `[not found error]`. The tags are
 * written lowercase, so this match stays case-sensitive.
 */
const RUNNER_ERROR_LINE = /^\[(?:[a-z0-9]+-(?:run|fmt)|[a-z0-9]+fmt) error\]/;

export interface RuntimeGateInput {
  artifactRecording: Recording;
  plan: StudioPlan;
  lastRuntimeSnapshot: RuntimeRecordingSnapshot | null;
  consoleLines: readonly string[];
}

export function runtimeGateChecks({
  artifactRecording,
  plan,
  lastRuntimeSnapshot,
  consoleLines,
}: RuntimeGateInput): StudioCheckResult[] {
  const results: StudioCheckResult[] = [];
  // A preview error line fails here too, matched by the preview gates' own
  // rule, so the two gates can never disagree about a line.
  const errorLines = consoleLines.filter(
    (line) => RUNNER_ERROR_LINE.test(line) || PREVIEW_ERROR_LINE.test(line),
  );
  const runtimeError =
    lastRuntimeSnapshot?.errorMessage ??
    (lastRuntimeSnapshot?.latestLifecycleEvent?.kind === "internal-error"
      ? lastRuntimeSnapshot.latestLifecycleEvent.text
      : null);
  results.push({
    id: "runtime.noErrors",
    ok: errorLines.length === 0 && !runtimeError,
    detail:
      runtimeError ??
      (errorLines.length === 0
        ? "no runtime or error-prefixed console failures"
        : errorLines.join(" | ")),
  });

  for (const action of plan.actions) {
    if (action.type === "expect.output") {
      const matched = consoleLines.some((line) => line.includes(action.contains));
      results.push({
        id: `checkpoint.output.${action.id}`,
        ok: matched,
        detail: matched
          ? `recorded console contains ${JSON.stringify(action.contains)}`
          : `recorded console never contains ${JSON.stringify(action.contains)}`,
      });
    }
    if (action.type === "expect.file") {
      const files = workspaceTextFilesOf(artifactRecording);
      const content = files[action.path];
      const matched = typeof content === "string" && content.includes(action.contains);
      results.push({
        id: `checkpoint.file.${action.id}`,
        ok: matched,
        detail: matched
          ? `final "${action.path}" contains ${JSON.stringify(action.contains)}`
          : `final "${action.path}" missing ${JSON.stringify(action.contains)}`,
      });
    }
  }

  return results;
}
