import { describe, expect, it } from "vite-plus/test";
import { areRuntimeRecordingSnapshotsEqual } from "./equality";
import type { RuntimeRecordingSnapshot } from "../types/runtime";

function snapshot(overrides: Partial<RuntimeRecordingSnapshot> = {}): RuntimeRecordingSnapshot {
  return {
    mode: "webcontainer",
    status: "ready",
    activeTab: "terminal",
    isCollapsed: false,
    isFullHeight: false,
    isSettingsOpen: false,
    consoleLines: ["hello"],
    terminalScrollLines: {},
    previewUrl: "https://example.test",
    previewPort: 3000,
    lastOutput: "done",
    activeCommand: null,
    errorMessage: null,
    terminalSessions: [],
    activeTerminalSessionId: null,
    ...overrides,
  } as RuntimeRecordingSnapshot;
}

describe("areRuntimeRecordingSnapshotsEqual", () => {
  it("treats an unchanged snapshot as equal", () => {
    expect(areRuntimeRecordingSnapshotsEqual(snapshot(), snapshot())).toBe(true);
  });

  // This comparator is the sole dedupe gate for runtime recording events, so a
  // recorded-and-replayed field it does not compare is silently dropped whenever
  // it is the only thing that changed. isFullHeight was exactly that hole: the
  // dock's full-height toggle never made it into a recording.
  it.each([
    ["activeTab", { activeTab: "agent" }],
    ["isCollapsed", { isCollapsed: true }],
    ["isFullHeight", { isFullHeight: true }],
    ["isSettingsOpen", { isSettingsOpen: true }],
    ["consoleLines", { consoleLines: ["hello", "world"] }],
    ["terminalScrollLines", { terminalScrollLines: { main: 4 } }],
    ["mode", { mode: "single-file" }],
    ["status", { status: "booting" }],
    ["previewUrl", { previewUrl: null }],
    ["previewPort", { previewPort: 4000 }],
    ["lastOutput", { lastOutput: "other" }],
    ["activeCommand", { activeCommand: "npm run dev" }],
    ["errorMessage", { errorMessage: "boom" }],
    ["activeTerminalSessionId", { activeTerminalSessionId: "s1" }],
  ] as [string, Partial<RuntimeRecordingSnapshot>][])(
    "reports a lone %s change as different",
    (_field, change) => {
      expect(areRuntimeRecordingSnapshotsEqual(snapshot(), snapshot(change))).toBe(false);
    },
  );
});
