// Replay-state resolution — public API.
//
// Split by track concern on top of a shared cursor core:
//   * cursor.ts    — time → event-index lookup shared by every track
//   * preview.ts   — preview iframe state
//   * workspace.ts — workspace/file/sidebar snapshot
//   * runtime.ts   — runtime snapshot
//   * slide.ts     — slide deck state
//
// Re-exported here so callers keep importing from "replayState" unchanged.

export { resolveReplayTime, isSeekReplayEvent, advanceReplayCursor } from "./cursor";

export { getPreviewReplayResult } from "./preview";
export type { PreviewReplayResult } from "./preview";

export { getWorkspaceReplayResult } from "./workspace";
export type { WorkspaceReplayResult } from "./workspace";

export { getRuntimeReplayResult } from "./runtime";
export type { RuntimeReplayResult } from "./runtime";

export { getSlideReplayResult } from "./slide";
export type { SlideReplayApplication, SlideReplayResult } from "./slide";
