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

vi.mock("../../hooks/useWorkspace", () => ({
  useWorkspaceLessonType: () => "react",
  useWorkspacePreviewVersion: () => 0,
  useWorkspaceSaveVersion: () => 0,
}));

const runtimeMetadata = {
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
