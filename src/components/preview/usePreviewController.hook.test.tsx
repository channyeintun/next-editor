import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApiClientStoreProvider,
  useApiClientStoreInstance,
} from "../../contexts/ApiClientStoreContext";
import {
  PreviewAdapterHandleProvider,
  usePreviewAdapterHandle,
} from "../../contexts/PreviewAdapterHandleContext";
import { PreviewPanelProvider } from "../../contexts/PreviewPanelContext";
import { RuntimePanelStoreProvider } from "../../contexts/RuntimePanelStoreContext";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
} from "../../contexts/WebContainerRuntimeContext";
import type { PreviewAdapterHandle } from "../../stores/previewAdapterHandle";
import type { ApiClientReplayState } from "../../types/slides";
import { RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE } from "./previewIframeUtils";
import { usePreviewController } from "./usePreviewController";

const editor = vi.hoisted(() => ({
  metadata: {
    currentRecording: null as unknown,
    isPlaying: false,
    isRecording: false,
    usesPlaybackModel: false,
  },
}));

vi.mock("../../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({
    handlePreviewEvent: vi.fn<() => void>(),
    handlePreviewInitialDocument: vi.fn<() => void>(),
    handlePreviewPatchBatch: vi.fn<() => void>(),
    handleWorkspaceEvent: vi.fn<() => void>(),
  }),
  useNextEditorMetadata: () => editor.metadata,
}));

const workspace = vi.hoisted(() => ({ previewVersion: 0 }));

vi.mock("../../hooks/useWorkspace", () => ({
  useWorkspaceLessonType: () => "react",
  useWorkspacePreviewVersion: () => workspace.previewVersion,
  useWorkspaceSaveVersion: () => 0,
}));

const idleRuntimeMetadata = {
  status: "idle",
  previewUrl: null,
  previewPort: null,
  isSupported: true,
  errorMessage: null,
  runnerConfig: {
    enabled: true,
    runOnStartup: false,
    runOnFileSave: false,
    initCommand: "",
    runCommand: "",
  },
  ambientStartEnabled: false,
} as unknown as WebContainerRuntimeMetadata;
let runtimeMetadata = idleRuntimeMetadata;

const runtimeActions = {
  startRuntime: vi.fn<() => Promise<void>>(async () => undefined),
} as unknown as WebContainerRuntimeActions;

function Providers({ children }: PropsWithChildren) {
  return (
    <PreviewAdapterHandleProvider>
      <PreviewPanelProvider>
        <RuntimePanelStoreProvider>
          <ApiClientStoreProvider>
            <WebContainerRuntimeActionsContext value={runtimeActions}>
              <WebContainerRuntimeMetadataContext value={runtimeMetadata}>
                {children}
              </WebContainerRuntimeMetadataContext>
            </WebContainerRuntimeActionsContext>
          </ApiClientStoreProvider>
        </RuntimePanelStoreProvider>
      </PreviewPanelProvider>
    </PreviewAdapterHandleProvider>
  );
}

function renderController() {
  return renderHook(() => usePreviewController(), { wrapper: Providers });
}

function mouseDown(clientX: number, clientY: number) {
  return {
    button: 0,
    clientX,
    clientY,
    preventDefault: vi.fn<() => void>(),
    stopPropagation: vi.fn<() => void>(),
  } as unknown as Parameters<ReturnType<typeof usePreviewController>["handleResizeStart"]>[0];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  workspace.previewVersion = 0;
  runtimeMetadata = idleRuntimeMetadata;
  editor.metadata = {
    currentRecording: null,
    isPlaying: false,
    isRecording: false,
    usesPlaybackModel: false,
  };
  document.body.replaceChildren();
});

describe("usePreviewController resize", () => {
  it("ends a floating-panel resize when no iframe is mounted (rrweb replay showing)", () => {
    const { result } = renderController();
    // While the rrweb replay is showing, RuntimePreviewRenderer mounts the replay
    // container instead of the iframe, so iframeRef stays null; the panel root
    // (containerRef) is still there.
    const panel = document.createElement("div");
    document.body.append(panel);
    result.current.containerRef.current = panel;
    expect(result.current.iframeRef.current).toBeNull();

    act(() => {
      result.current.handleResizeStart(mouseDown(100, 100));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });

    expect(result.current.isResizing).toBe(false);
    expect(result.current.disablePointerEvents).toBe(false);
  });
});

describe("usePreviewController API client replay", () => {
  const recordedState: ApiClientReplayState = {
    request: { method: "POST", path: "/recorded", headers: {}, body: "{}" },
    sending: false,
    history: [],
  };

  function renderWithHandles() {
    return renderHook(
      () => ({
        controller: usePreviewController(),
        handle: usePreviewAdapterHandle(),
        store: useApiClientStoreInstance(),
      }),
      { wrapper: Providers },
    );
  }

  function applyPreviewState(
    handle: PreviewAdapterHandle,
    apiClientState: ApiClientReplayState,
  ): void {
    act(() => {
      handle.snapshotApplier.current?.({ size: "medium", apiClientState });
    });
  }

  it("restores the recorded request after the viewer changed the panel", () => {
    const { result } = renderWithHandles();
    applyPreviewState(result.current.handle, recordedState);
    expect(result.current.store.getSnapshot().context.path).toBe("/recorded");

    // Paused, the viewer edits the live API panel; resuming re-applies the same
    // recorded state (the machine invalidates and resyncs every track on PLAY).
    act(() => {
      result.current.store.trigger.setPath({ path: "/mine" });
    });
    applyPreviewState(result.current.handle, recordedState);

    expect(result.current.store.getSnapshot().context.path).toBe("/recorded");
  });

  it("does not re-apply or serialize a recorded state the store still shows", () => {
    const { result } = renderWithHandles();
    const contexts: unknown[] = [];
    const subscription = result.current.store.subscribe((snapshot) => {
      contexts.push(snapshot.context);
    });
    const stringify = vi.spyOn(JSON, "stringify");

    applyPreviewState(result.current.handle, recordedState);
    applyPreviewState(result.current.handle, recordedState);

    subscription.unsubscribe();
    expect(contexts).toHaveLength(1);
    expect(stringify).not.toHaveBeenCalledWith(recordedState);
  });
});

describe("usePreviewController rrweb replay surface", () => {
  afterEach(() => {
    editor.metadata = {
      currentRecording: null,
      isPlaying: false,
      isRecording: false,
      usesPlaybackModel: false,
    };
  });

  function playRecording(recording: Record<string, unknown>) {
    editor.metadata = {
      currentRecording: { id: "recording-1", ...recording },
      isPlaying: true,
      isRecording: false,
      usesPlaybackModel: true,
    };
    return renderController();
  }

  const rrwebEvent = (type: number, timestamp: number) => ({ type, timestamp, data: {} });

  it("replaces the iframe with the rrweb replay when the recording has a seed", () => {
    const { result } = playRecording({
      previewInitialDocuments: [
        { version: 2, time: 0, documentId: "doc-1", events: [rrwebEvent(4, 0), rrwebEvent(2, 0)] },
      ],
      previewPatchBatches: [],
    });

    expect(result.current.isRrwebReplayActive).toBe(true);
  });

  it("keeps the iframe for batches with no seed, which rrweb cannot replay", () => {
    const { result } = playRecording({
      previewInitialDocuments: [],
      previewPatchBatches: [
        {
          version: 2,
          time: 0,
          source: "runtime-preview",
          documentId: "doc-1",
          events: [rrwebEvent(3, 0)],
        },
      ],
    });

    expect(result.current.isRrwebReplayActive).toBe(false);
  });
});

describe("usePreviewController runtime snapshots", () => {
  const RUNTIME_URL = "https://abc--3000--xyz.local-corp.webcontainer-api.io";

  // A cross-origin runtime frame: the parent cannot read its document, so a
  // snapshot has to be requested over postMessage.
  function mountRuntimeFrame(controller: ReturnType<typeof usePreviewController>) {
    const postMessage = vi.fn<(message: { type?: string; payload?: unknown }) => void>();
    const iframe = document.createElement("iframe");
    iframe.setAttribute("src", RUNTIME_URL);
    Object.defineProperty(iframe, "contentDocument", { value: null });
    Object.defineProperty(iframe, "contentWindow", {
      value: {
        postMessage,
        get document(): Document {
          throw new DOMException("Blocked a cross-origin frame.", "SecurityError");
        },
      },
    });
    document.body.append(iframe);
    controller.iframeRef.current = iframe;
    return postMessage;
  }

  function snapshotRequestReasons(postMessage: ReturnType<typeof mountRuntimeFrame>) {
    return postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE)
      .map((message) => (message.payload as { reason: string }).reason);
  }

  function renderWithOpenRuntime(isRecording: boolean) {
    vi.useFakeTimers();
    runtimeMetadata = { ...idleRuntimeMetadata, status: "ready", previewUrl: RUNTIME_URL };
    editor.metadata = { ...editor.metadata, isRecording };
    const view = renderController();
    const postMessage = mountRuntimeFrame(view.result.current);
    act(() => {
      view.result.current.handleFloat();
    });
    // Let whatever the open requested time out, so a later request is not
    // folded into a pending one.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    postMessage.mockClear();

    const editWorkspace = () => {
      workspace.previewVersion += 1;
      view.rerender();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
    };

    return { editWorkspace, postMessage };
  }

  it("does not snapshot the live runtime on every edit while not recording", () => {
    const { editWorkspace, postMessage } = renderWithOpenRuntime(false);

    editWorkspace();
    editWorkspace();

    expect(snapshotRequestReasons(postMessage)).toEqual([]);
  });

  it("refreshes the fallback snapshot after an edit while recording", () => {
    const { editWorkspace, postMessage } = renderWithOpenRuntime(true);

    editWorkspace();

    expect(snapshotRequestReasons(postMessage)).toEqual(["edit"]);
  });
});
