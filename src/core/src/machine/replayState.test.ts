import { describe, expect, it } from "vite-plus/test";
import type { PreviewEvent, Slide, SlideEvent } from "../slides";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../../types/workspace";
import {
  getPreviewReplayResult,
  getRuntimeReplayResult,
  getSlideReplayResult,
  getWorkspaceReplayResult,
} from "./replayState";

function createWorkspaceSnapshot(content: string): WorkspaceRecordingSnapshot {
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

  it("does not read the current workspace snapshot when the workspace cursor is unchanged", () => {
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
    let snapshotReads = 0;

    const unchangedCursor = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 50,
      getCurrentSnapshot: () => {
        snapshotReads++;
        return firstSnapshot;
      },
      lastAppliedIndex: 0,
    });

    expect(unchangedCursor.nextIndex).toBe(0);
    expect(unchangedCursor.snapshotToApply).toBeUndefined();
    expect(snapshotReads).toBe(0);

    const advancedCursor = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      getCurrentSnapshot: () => {
        snapshotReads++;
        return firstSnapshot;
      },
      lastAppliedIndex: 0,
    });

    expect(advancedCursor.nextIndex).toBe(1);
    expect(advancedCursor.snapshotToApply).toBe(secondSnapshot);
    expect(snapshotReads).toBe(1);
  });

  it("seeks to the latest slide event at or before the target time", () => {
    const slides: Slide[] = [
      {
        id: "slide-1",
        order: 0,
        content: "<section>One</section>",
        contentType: "html",
      },
      {
        id: "slide-2",
        order: 1,
        content: "<section>Two</section>",
        contentType: "html",
      },
    ];
    const slideEvents: SlideEvent[] = [
      {
        type: "slide_open",
        timestamp: 0,
        slideId: "slide-1",
        isMaximized: true,
        indexv: 0,
      },
      {
        type: "slide_change",
        timestamp: 100,
        slideId: "slide-2",
        indexv: 1,
      },
    ];

    const result = getSlideReplayResult({
      slideEvents,
      slides,
      currentTime: 150,
      lastAppliedIndex: -1,
      isSeeking: true,
    });

    expect(result.nextIndex).toBe(1);
    expect(result.applications).toEqual([
      {
        slideIndex: 1,
        slideState: {
          isOpen: true,
          isMaximized: false,
          currentSlideId: "slide-2",
          indexv: 1,
          currentInteraction: undefined,
        },
      },
    ]);
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
