import { describe, expect, it } from "vite-plus/test";
import type { PreviewEvent } from "../slides";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import type {
  WorkspaceRecordingEvent,
  WorkspaceRecordingSnapshot,
} from "../../../types/workspace";
import {
  getPreviewReplayResult,
  getRuntimeReplayResult,
  getWorkspaceReplayResult,
} from "./replayState";

function createWorkspaceSnapshot(
  content: string,
): WorkspaceRecordingSnapshot {
  return {
    activeFilePath: "index.html",
    collapsedFolders: [],
    project: {
      id: "project-1",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        "index.html": {
          path: "index.html",
          name: "index.html",
          language: "html",
          content,
        },
      },
    },
  };
}

describe("replayState", () => {
  it("rebuilds preview state on seek without replaying transient interactions", () => {
    const previewEvents: PreviewEvent[] = [
      {
        type: "preview_open",
        timestamp: 0,
        size: "small",
        content: "<html><body>Initial</body></html>",
        scrollTop: 0,
        scrollLeft: 0,
      },
      {
        type: "preview_scroll",
        timestamp: 100,
        size: "medium",
        scrollTop: 80,
      },
      {
        type: "preview_interaction",
        timestamp: 200,
        size: "medium",
        interaction: {
          type: "click",
          timestamp: 200,
          target: {
            tagName: "button",
            xpath: "/html/body/button",
          },
        },
      },
      {
        type: "preview_refresh",
        timestamp: 300,
        size: "large",
        content: "<html><body>Refreshed</body></html>",
      },
    ];

    const seekToInteraction = getPreviewReplayResult({
      previewEvents,
      currentTime: 250,
      lastAppliedIndex: 3,
      lastAppliedState: undefined,
      isSeeking: true,
    });

    expect(seekToInteraction.appliedStates).toHaveLength(1);
    expect(seekToInteraction.nextIndex).toBe(2);
    expect(seekToInteraction.appliedStates[0]).toEqual({
      size: "medium",
      content: "<html><body>Initial</body></html>",
      scrollTop: 80,
      scrollLeft: 0,
      refreshKey: undefined,
      currentInteraction: undefined,
    });

    const seekToRefresh = getPreviewReplayResult({
      previewEvents,
      currentTime: 350,
      lastAppliedIndex: 2,
      lastAppliedState: seekToInteraction.retainedState,
      isSeeking: true,
    });

    expect(seekToRefresh.appliedStates).toHaveLength(1);
    expect(seekToRefresh.nextIndex).toBe(3);
    expect(seekToRefresh.appliedStates[0]).toMatchObject({
      size: "large",
      content: "<html><body>Refreshed</body></html>",
      scrollTop: 80,
      scrollLeft: 0,
      refreshKey: 300,
      currentInteraction: undefined,
    });
  });

  it("skips equal workspace snapshots but reapplies when seeking backward", () => {
    const firstSnapshot = createWorkspaceSnapshot("first");
    const secondSnapshot = createWorkspaceSnapshot("second");
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
      {
        timestamp: 100,
        snapshot: secondSnapshot,
      },
    ];

    const equalCurrentSnapshot = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      currentSnapshot: secondSnapshot,
      lastAppliedIndex: 0,
    });

    expect(equalCurrentSnapshot.nextIndex).toBe(1);
    expect(equalCurrentSnapshot.snapshotToApply).toBeUndefined();

    const backwardSeek = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 50,
      currentSnapshot: secondSnapshot,
      lastAppliedIndex: 1,
    });

    expect(backwardSeek.nextIndex).toBe(0);
    expect(backwardSeek.snapshotToApply).toBe(firstSnapshot);
  });

  it("returns the latest runtime snapshot when its replay cursor advances", () => {
    const runtimeEvents: RuntimeRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: {
          mode: "webcontainer",
          status: "starting",
          previewUrl: null,
        },
      },
      {
        timestamp: 120,
        snapshot: {
          mode: "webcontainer",
          status: "ready",
          previewUrl: "http://localhost:4173",
        },
      },
    ];

    const result = getRuntimeReplayResult({
      runtimeEvents,
      currentTime: 150,
      lastAppliedIndex: 0,
    });

    expect(result.nextIndex).toBe(1);
    expect(result.snapshotToApply).toEqual(runtimeEvents[1].snapshot);
  });
});
