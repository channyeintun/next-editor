import { act, render, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextEditorProvider } from "./NextEditorProvider";
import { NextEditorActorContext } from "./NextEditorActorContext";
import {
  PreviewAdapterHandleProvider,
  usePreviewAdapterHandle,
} from "./PreviewAdapterHandleContext";
import { RuntimePanelStoreProvider } from "./RuntimePanelStoreContext";
import { SlidesStoreProvider } from "./SlidesStoreContext";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProvider";
import { WhiteboardStoreProvider } from "./WhiteboardStoreContext";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { WorkspaceEventRecorder } from "../components/WorkspaceEventRecorder";
import type { NextEditorActions } from "./NextEditorContext";
import type { EditorActorRef } from "../core/src/useNextEditor";
import type { PreviewAdapterHandle } from "../stores/previewAdapterHandle";
import type { Recording } from "../core/src/types";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";
import type { WorkspaceActions } from "./WorkspaceContext";

/** The providers Editor.tsx wraps NextEditorProvider in, minus collaboration and UI. */
function EditorProviders({ children }: PropsWithChildren) {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider allowAmbientStart={false}>
        <SlidesStoreProvider>
          <WhiteboardStoreProvider>
            <RuntimePanelStoreProvider>
              <PreviewAdapterHandleProvider>
                <NextEditorProvider>{children}</NextEditorProvider>
              </PreviewAdapterHandleProvider>
            </RuntimePanelStoreProvider>
          </WhiteboardStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}

function renderNextEditorProvider() {
  const captured: {
    actions: NextEditorActions | null;
    actor: EditorActorRef | null;
    previewHandle: PreviewAdapterHandle | null;
  } = { actions: null, actor: null, previewHandle: null };

  function Capture() {
    captured.actions = useNextEditorActions();
    captured.actor = NextEditorActorContext.useActorRef();
    captured.previewHandle = usePreviewAdapterHandle();
    return null;
  }

  render(
    <EditorProviders>
      <Capture />
    </EditorProviders>,
  );

  const { actions, actor, previewHandle } = captured;
  if (!actions || !actor || !previewHandle) throw new Error("Expected the providers to render");
  const send = vi.spyOn(actor, "send");
  const stopRecordingSends = () =>
    send.mock.calls.filter(([event]) => event.type === "STOP_RECORDING").length;
  return { actions, previewHandle, stopRecordingSends };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NextEditorProvider stopRecording", () => {
  // The preview flushes its last rrweb batch before the take stops, and every
  // stop control (button, shortcut, collaboration handoff) may fire at once.
  it("shares one stop across concurrent calls and stops once the preview is ready", async () => {
    const { actions, previewHandle, stopRecordingSends } = renderNextEditorProvider();
    let finishPreparing: () => void = () => {};
    const prepare = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finishPreparing = resolve;
        }),
    );
    previewHandle.recordingStopPreparer.current = prepare;

    const first = actions.stopRecording();
    const second = actions.stopRecording();

    expect(second).toBe(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(stopRecordingSends()).toBe(0);

    await act(async () => {
      finishPreparing();
      await first;
    });

    expect(stopRecordingSends()).toBe(1);
  });

  it("still stops when the preview fails to prepare, and the next call starts afresh", async () => {
    const { actions, previewHandle, stopRecordingSends } = renderNextEditorProvider();
    previewHandle.recordingStopPreparer.current = () =>
      Promise.reject(new Error("preview flush failed"));

    const failed = actions.stopRecording();
    await act(async () => {
      await expect(failed).rejects.toThrow("preview flush failed");
    });
    expect(stopRecordingSends()).toBe(1);

    previewHandle.recordingStopPreparer.current = null;
    const retried = actions.stopRecording();
    expect(retried).not.toBe(failed);
    await act(async () => {
      await retried;
    });
    expect(stopRecordingSends()).toBe(2);
  });
});

function workspaceSnapshot(activeFilePath: string, content: string): WorkspaceRecordingSnapshot {
  return {
    activeFilePath,
    collapsedFolders: [],
    sidebarScrollTop: 0,
    project: {
      id: "lesson-project",
      name: "Lesson",
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
        "styles.css": {
          path: "styles.css",
          name: "styles.css",
          language: "css",
          content: "body {}",
        },
      },
    },
  };
}

describe("NextEditorProvider replayed workspace snapshots", () => {
  // docs/state-machines.md: workspace state has one writer at a time. A replayed
  // snapshot is loaded into the store, and WorkspaceEventRecorder (which turns
  // store changes into WORKSPACE_EVENTs) must not report it back as the viewer's
  // own edit: in `playing` that pauses the lesson and detaches the replay.
  it("does not report a replayed workspace change as the viewer's edit", async () => {
    const captured: { actions: NextEditorActions | null; workspace: WorkspaceActions | null } = {
      actions: null,
      workspace: null,
    };
    let actor: EditorActorRef | null = null;

    function RecorderHarness() {
      const actions = useNextEditorActions();
      const { currentRecording, isRecording } = useNextEditorMetadata();
      captured.actions = actions;
      captured.workspace = useWorkspaceActions();
      actor = NextEditorActorContext.useActorRef();
      return (
        <WorkspaceEventRecorder
          handleWorkspaceEvent={actions.handleWorkspaceEvent}
          isRecording={isRecording}
          shouldTrackWorkspaceChanges={isRecording || Boolean(currentRecording)}
        />
      );
    }

    render(
      <EditorProviders>
        <RecorderHarness />
      </EditorProviders>,
    );
    const editor = actor as EditorActorRef | null;
    if (!editor || !captured.actions) throw new Error("Expected the providers to render");

    const recording: Recording = {
      version: 4,
      id: "lesson",
      name: "Lesson",
      createdAt: 1,
      duration: 1000,
      keyframeInterval: 120,
      frames: [
        {
          timestamp: 0,
          isKeyframe: true,
          state: {
            content: "<h1>first</h1>",
            selection: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
              selectionStartLineNumber: 1,
              selectionStartColumn: 1,
              positionLineNumber: 1,
              positionColumn: 1,
            },
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: { x: 0, y: 0, visible: false },
          },
        },
      ],
      workspaceEvents: [
        { timestamp: 0, snapshot: workspaceSnapshot("index.html", "<h1>first</h1>") },
        { timestamp: 100, snapshot: workspaceSnapshot("styles.css", "<h1>second</h1>") },
      ],
    };

    act(() => captured.actions?.loadRecording(recording));
    await waitFor(() => expect(editor.getSnapshot().matches({ playback: "ready" })).toBe(true));
    act(() => captured.actions?.play());
    act(() => editor.send({ type: "TICK", currentTime: 150 }));

    expect(captured.workspace?.getActiveFilePath()).toBe("styles.css");
    expect(editor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(editor.getSnapshot().context.hasManualWorkspaceOverride).toBe(false);
  });
});
