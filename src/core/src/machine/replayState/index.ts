// Replay-state resolution — public API.
//
// Split by track concern on top of a shared cursor core:
//   * cursor.ts    — replay time and cursor helpers shared by every track
//   * preview.ts   — preview iframe state
//   * workspace.ts — workspace/file/sidebar snapshot
//   * runtime.ts   — runtime snapshot
//   * slide.ts     — slide deck state
//   * whiteboard.ts — whiteboard scene state
//   * chat.ts      — coding-agent chat transcript
//   * viewChanges.ts — where a track last changed how its panel is shown
//
// Re-exported here so callers keep importing from "replayState" unchanged.

export { resolveReplayTime, isReplayResync } from "./cursor";
export { getPreviewReplayResult } from "./preview";
export {
  getRecordedActiveFilePath,
  getWorkspaceReplayResult,
  resolveWorkspaceSnapshotBetween,
  withReplayedSidebarPreference,
} from "./workspace";
export {
  getRuntimeDockViewChangeIndex,
  getRuntimeReplayResult,
  withRuntimeDockView,
} from "./runtime";
export { EMPTY_CHAT_CHECKPOINT, getChatReplayResult } from "./chat";
export {
  getSlideReplayResult,
  getSlideViewChangeIndex,
  withSlideView,
  type SlidePanelView,
  type SlideReplayApplication,
} from "./slide";
export {
  getWhiteboardReplayResult,
  getWhiteboardViewChangeIndex,
  withWhiteboardView,
  type WhiteboardPanelView,
} from "./whiteboard";
