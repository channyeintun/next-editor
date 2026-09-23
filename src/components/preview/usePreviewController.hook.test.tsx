import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiClientStoreProvider } from "../../contexts/ApiClientStoreContext";
import { PreviewAdapterHandleProvider } from "../../contexts/PreviewAdapterHandleContext";
import { PreviewPanelProvider } from "../../contexts/PreviewPanelContext";
import { RuntimePanelStoreProvider } from "../../contexts/RuntimePanelStoreContext";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
} from "../../contexts/WebContainerRuntimeContext";
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
