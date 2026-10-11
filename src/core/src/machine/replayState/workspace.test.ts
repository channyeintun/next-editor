import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../workspace";
import {
  getWorkspaceReplayResult,
  resolveWorkspaceSnapshotBetween,
  withReplayedSidebarPreference,
} from "./workspace";

function snapshot(
  activeFilePath: string,
  fields: Partial<WorkspaceRecordingSnapshot> = {},
): WorkspaceRecordingSnapshot {
  return {
    activeFilePath,
    project: {
      id: "p",
      name: "P",
      lessonType: "javascript",
      entryFilePath: "a.js",
      folders: [],
      files: {
        "a.js": { path: "a.js", name: "a.js", language: "javascript", content: "a" },
        "b.js": { path: "b.js", name: "b.js", language: "javascript", content: "b" },
      },
    },
    ...fields,
  };
}

describe("withReplayedSidebarPreference", () => {
  it("drops the explorer state from every snapshot after the first", () => {
    expect(
      withReplayedSidebarPreference(snapshot("a.js", { sidebarCollapsed: true }), false),
    ).toEqual(snapshot("a.js"));
    expect(
      withReplayedSidebarPreference(snapshot("a.js", { sidebarCollapsed: false }), false),
    ).toEqual(snapshot("a.js"));
  });

  // A recorded false cannot tell "the lesson asks for an open tree" from "the author had
  // it open", and leaving the viewer's preference alone is the default.
  it("keeps it on the first snapshot only when that shuts the explorer", () => {
    const shut = snapshot("a.js", { sidebarCollapsed: true });
    expect(withReplayedSidebarPreference(shut, true)).toBe(shut);
    expect(
      withReplayedSidebarPreference(snapshot("a.js", { sidebarCollapsed: false }), true),
    ).toEqual(snapshot("a.js"));
  });

  it("returns a snapshot without the field as it is", () => {
    const plain = snapshot("a.js");
    expect(withReplayedSidebarPreference(plain, true)).toBe(plain);
    expect(withReplayedSidebarPreference(plain, false)).toBe(plain);
  });
});

describe("replaying the explorer state the recorder wrote on every event", () => {
  const events: WorkspaceRecordingEvent[] = [
    { timestamp: 0, snapshot: snapshot("a.js", { sidebarCollapsed: true, sidebarWidthDelta: 0 }) },
    { timestamp: 100, snapshot: snapshot("b.js", { sidebarCollapsed: true }) },
    {
      timestamp: 200,
      snapshot: snapshot("a.js", { sidebarCollapsed: false, sidebarWidthDelta: 40 }),
    },
  ];

  it("hands it on only with the first event", () => {
    const at = (currentTime: number, lastAppliedIndex: number) =>
      getWorkspaceReplayResult({ workspaceEvents: events, currentTime, lastAppliedIndex })
        .snapshotToApply;

    expect(at(0, -1)?.sidebarCollapsed).toBe(true);
    expect(at(100, 0)).not.toHaveProperty("sidebarCollapsed");
    expect(at(200, 1)).not.toHaveProperty("sidebarCollapsed");
    expect(at(200, 1)?.sidebarWidthDelta).toBe(40);
    // A seek back to the start re-applies the lesson's opening explorer state.
    expect(at(0, 2)?.sidebarCollapsed).toBe(true);
  });

  it("drops it from the snapshot a retake puts back", () => {
    const restored = resolveWorkspaceSnapshotBetween(events, 1, 2);
    expect(restored).not.toHaveProperty("sidebarCollapsed");
    expect(restored.sidebarWidthDelta).toBe(-40);
  });
});
