import type { StudioRuntimeMode } from "./plan";
import type { StudioBuildManifest, StudioCheckResult, StudioRenderReport } from "./report";
import type { StudioWorkflow } from "./workflow/workflowQueue";

/**
 * What /studio publishes on `window.__NEXT_EDITOR_STUDIO__` so an automation
 * harness can read its renders without scraping the DOM. StudioController
 * writes it and scripts/studio-render.ts reads it; both use this one type, so
 * renaming a field fails the typecheck instead of a render. Types only — the
 * CLI imports it with `import type`, which bun strips, and gets the window
 * slot's declaration below with it.
 */
export interface StudioWindowHandle {
  runs: StudioWindowRun[];
  /** The repeatability verdict, published after the second render. */
  comparison: StudioCheckResult[] | null;
  running: boolean;
  /**
   * The studio workflow's queue (useStudioWorkflow), with the issue report of
   * a lesson it stopped at; absent until the workflow hook publishes it.
   */
  workflow?: StudioWorkflow | null;
}

/** One finished render as the window handle carries it. */
export interface StudioWindowRun {
  index: number;
  mode: StudioRuntimeMode;
  outcome: StudioRenderReport["outcome"];
  report: StudioRenderReport;
  manifest: StudioBuildManifest;
}

declare global {
  interface Window {
    __NEXT_EDITOR_STUDIO__?: StudioWindowHandle;
  }
}
