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

function createWorkspaceSnapshot(
  content: string,
  sidebarScrollTop = 0,
  sidebarWidthDelta?: number,
  previewDockWidthDelta?: number,
): WorkspaceRecordingSnapshot {
  return {
    activeFilePath: "index.html",
    collapsedFolders: [],
    sidebarScrollTop,
    ...(sidebarWidthDelta === undefined ? {} : { sidebarWidthDelta }),
    ...(previewDockWidthDelta === undefined ? {} : { previewDockWidthDelta }),
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
        route: "/",
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
        type: "preview_route_change",
        timestamp: 150,
        size: "medium",
        route: "/about",
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
    expect(seekToInteraction.nextIndex).toBe(3);
    expect(seekToInteraction.appliedStates[0]).toEqual({
      size: "medium",
      content: "<html><body>Initial</body></html>",
      route: "/about",
      scrollTop: 80,
      scrollLeft: 0,
      refreshKey: undefined,
      currentInteraction: undefined,
    });

    const seekToRefresh = getPreviewReplayResult({
      previewEvents,
      currentTime: 350,
      lastAppliedIndex: 3,
      lastAppliedState: seekToInteraction.retainedState,
      isSeeking: true,
    });

    expect(seekToRefresh.appliedStates).toHaveLength(1);
    expect(seekToRefresh.nextIndex).toBe(4);
    expect(seekToRefresh.appliedStates[0]).toMatchObject({
      size: "large",
      content: "<html><body>Refreshed</body></html>",
      route: "/about",
      scrollTop: 80,
      scrollLeft: 0,
      refreshKey: 300,
      currentInteraction: undefined,
    });
  });

  it("carries API client request/response state through replay and seeking", () => {
    const previewEvents: PreviewEvent[] = [
      { type: "api_client_mode", timestamp: 0, size: "medium", activeMode: "api" },
      {
        type: "api_client_request",
        timestamp: 100,
        size: "medium",
        apiClientRequest: { method: "POST", path: "/api/todos", headers: {}, body: '{"x":1}' },
      },
      {
        type: "api_client_response",
        timestamp: 200,
        size: "medium",
        apiClientResult: {
          ok: true,
          status: 201,
          statusText: "Created",
          headers: [["content-type", "application/json"]],
          body: '{"id":1}',
          durationMs: 12,
        },
      },
      { type: "preview_scroll", timestamp: 300, size: "medium", scrollTop: 40 },
    ];

    // Seek between request and response: request present, still sending.
    const mid = getPreviewReplayResult({
      previewEvents,
      currentTime: 150,
      lastAppliedIndex: -1,
      lastAppliedState: undefined,
      isSeeking: true,
    });
    expect(mid.appliedStates[0].activeMode).toBe("api");
    expect(mid.appliedStates[0].apiClientState).toEqual({
      request: { method: "POST", path: "/api/todos", headers: {}, body: '{"x":1}' },
      sending: true,
      history: undefined,
    });

    // Seek past the unrelated scroll event: API state is carried forward intact
    // (the response is retained, not dropped or duplicated) and history is built.
    const afterScroll = getPreviewReplayResult({
      previewEvents,
      currentTime: 350,
      lastAppliedIndex: -1,
      lastAppliedState: undefined,
      isSeeking: true,
    });
    const result = {
      ok: true as const,
      status: 201,
      statusText: "Created",
      headers: [["content-type", "application/json"]] as [string, string][],
      body: '{"id":1}',
      durationMs: 12,
    };
    expect(afterScroll.appliedStates[0].apiClientState).toEqual({
      request: { method: "POST", path: "/api/todos", headers: {}, body: '{"x":1}' },
      sending: false,
      result,
      history: [
        {
          id: "200",
          request: { method: "POST", path: "/api/todos", headers: {}, body: '{"x":1}' },
          result,
        },
      ],
    });
  });

  it("implies API mode from a request even without a recorded mode switch", () => {
    // Recording started while already in API mode, so no api_client_mode event.
    const previewEvents: PreviewEvent[] = [
      {
        type: "api_client_request",
        timestamp: 0,
        size: "medium",
        apiClientRequest: { method: "GET", path: "/api/time", headers: {}, body: undefined },
      },
    ];

    const result = getPreviewReplayResult({
      previewEvents,
      currentTime: 50,
      lastAppliedIndex: -1,
      lastAppliedState: undefined,
      isSeeking: true,
    });

    expect(result.appliedStates[0].activeMode).toBe("api");
  });

  it("keeps API client state (incl. history) when replay switches back to browser mode", () => {
    const previewEvents: PreviewEvent[] = [
      {
        type: "api_client_request",
        timestamp: 0,
        size: "medium",
        activeMode: "api",
        apiClientRequest: { method: "GET", path: "/api/time", headers: {}, body: undefined },
      },
      {
        type: "api_client_response",
        timestamp: 50,
        size: "medium",
        apiClientResult: {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: [],
          body: "12:00",
          durationMs: 5,
        },
      },
      { type: "api_client_mode", timestamp: 100, size: "medium", activeMode: "browser" },
    ];

    const afterSwitch = getPreviewReplayResult({
      previewEvents,
      currentTime: 150,
      lastAppliedIndex: -1,
      lastAppliedState: undefined,
      isSeeking: true,
    });

    // Like the live store, history/result survive a mode switch (the panel is just
    // hidden in browser mode), so switching back to API still shows them.
    expect(afterSwitch.appliedStates[0].activeMode).toBe("browser");
    expect(afterSwitch.appliedStates[0].apiClientState?.history).toHaveLength(1);
    expect(afterSwitch.appliedStates[0].apiClientState?.result).toBeDefined();
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

  it("replays sidebar resize deltas against the current local width", () => {
    const firstSnapshot = createWorkspaceSnapshot("same", 0, 0);
    const resizedSnapshot = createWorkspaceSnapshot("same", 0, 52);
    const currentSnapshot = createWorkspaceSnapshot("same", 0);
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
      {
        timestamp: 100,
        snapshot: resizedSnapshot,
      },
    ];

    const resizeForward = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      currentSnapshot,
      lastAppliedIndex: 0,
    });

    expect(resizeForward.nextIndex).toBe(1);
    expect(resizeForward.snapshotToApply).toMatchObject({
      sidebarWidthDelta: 52,
    });
  });

  it("keeps the local sidebar width when the recording did not resize it", () => {
    const firstSnapshot = createWorkspaceSnapshot("first", 0, 0);
    const currentSnapshot = createWorkspaceSnapshot("outside", 0);
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
    ];

    const initialReplay = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 0,
      currentSnapshot,
      lastAppliedIndex: -1,
    });

    expect(initialReplay.nextIndex).toBe(0);
    expect(initialReplay.snapshotToApply).toMatchObject({
      sidebarWidthDelta: 0,
    });
  });

  it("undoes later sidebar resize deltas when seeking backward", () => {
    const firstSnapshot = createWorkspaceSnapshot("first", 0, 0);
    const expandedSnapshot = createWorkspaceSnapshot("expanded", 0, 40);
    const narrowedSnapshot = createWorkspaceSnapshot("narrowed", 0, -15);
    const currentSnapshot = createWorkspaceSnapshot("narrowed", 0);
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
      {
        timestamp: 100,
        snapshot: expandedSnapshot,
      },
      {
        timestamp: 200,
        snapshot: narrowedSnapshot,
      },
    ];

    const backwardSeek = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      currentSnapshot,
      lastAppliedIndex: 2,
    });

    expect(backwardSeek.nextIndex).toBe(1);
    expect(backwardSeek.snapshotToApply).toMatchObject({
      sidebarWidthDelta: 15,
    });
  });

  it("replays docked-preview resize deltas against the current local width", () => {
    const firstSnapshot = createWorkspaceSnapshot("same", 0, 0, 0);
    const resizedSnapshot = createWorkspaceSnapshot("same", 0, undefined, 64);
    const currentSnapshot = createWorkspaceSnapshot("same", 0);
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
      {
        timestamp: 100,
        snapshot: resizedSnapshot,
      },
    ];

    const resizeForward = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      currentSnapshot,
      lastAppliedIndex: 0,
    });

    expect(resizeForward.nextIndex).toBe(1);
    expect(resizeForward.snapshotToApply).toMatchObject({
      previewDockWidthDelta: 64,
    });
  });

  it("undoes later docked-preview resize deltas when seeking backward", () => {
    const firstSnapshot = createWorkspaceSnapshot("first", 0, 0, 0);
    const expandedSnapshot = createWorkspaceSnapshot("expanded", 0, undefined, 50);
    const narrowedSnapshot = createWorkspaceSnapshot("narrowed", 0, undefined, -20);
    const currentSnapshot = createWorkspaceSnapshot("narrowed", 0);
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
      {
        timestamp: 100,
        snapshot: expandedSnapshot,
      },
      {
        timestamp: 200,
        snapshot: narrowedSnapshot,
      },
    ];

    const backwardSeek = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      currentSnapshot,
      lastAppliedIndex: 2,
    });

    expect(backwardSeek.nextIndex).toBe(1);
    expect(backwardSeek.snapshotToApply).toMatchObject({
      previewDockWidthDelta: 20,
    });
  });

  it("replays scroll-only workspace snapshots and restores scroll when seeking backward", () => {
    const firstSnapshot = createWorkspaceSnapshot("same", 0);
    const scrolledSnapshot = createWorkspaceSnapshot("same", 360);
    const workspaceEvents: WorkspaceRecordingEvent[] = [
      {
        timestamp: 0,
        snapshot: firstSnapshot,
      },
      {
        timestamp: 100,
        snapshot: scrolledSnapshot,
      },
    ];

    const scrollForward = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 100,
      currentSnapshot: firstSnapshot,
      lastAppliedIndex: 0,
    });

    expect(scrollForward.nextIndex).toBe(1);
    expect(scrollForward.snapshotToApply).toBe(scrolledSnapshot);

    const backwardSeek = getWorkspaceReplayResult({
      workspaceEvents,
      currentTime: 50,
      currentSnapshot: scrolledSnapshot,
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
