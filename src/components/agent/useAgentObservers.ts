import type { AgentObservers } from "../../agent/types";
import { usePreviewAdapterHandle } from "../../contexts/PreviewAdapterHandleContext";
import { useWebContainerRuntimeSnapshotGetter } from "../../hooks/useWebContainerRuntime";
import { isWebContainerRuntimeSupported } from "../../runtime/webcontainer/sharedContainer";

/**
 * The runtime and preview observation hooks a Send hands the agent run. Each
 * reads the live runtime snapshot or preview when a tool calls it, not when the
 * panel renders, so the panel subscribes to no runtime state: support comes
 * from the same environment check the runtime provider makes, not from its
 * metadata context, which changes on every runtime status and preview event.
 *
 * `modelLabel` and `supportsImages` describe the model selected at Send, which
 * decides whether capture_preview may return a screenshot.
 */
export function useAgentObservers(modelLabel: string, supportsImages: boolean): AgentObservers {
  const previewHandle = usePreviewAdapterHandle();
  const getRuntimeSnapshot = useWebContainerRuntimeSnapshotGetter();

  return {
    getRuntimeDiagnostics: () => {
      const snapshot = getRuntimeSnapshot();
      return {
        activeCommand: snapshot.activeCommand,
        errorMessage: snapshot.errorMessage,
        isSupported: isWebContainerRuntimeSupported(),
        lastOutput: snapshot.lastOutput,
        latestLifecycleEvent: snapshot.latestLifecycleEvent,
        latestPreviewMessage: snapshot.latestPreviewMessage,
        previewPort: snapshot.previewPort,
        previewUrl: snapshot.previewUrl,
        status: snapshot.status,
      };
    },
    getPreviewInspection: async () =>
      (await previewHandle.livePreviewInspectionGetter.current?.()) ?? null,
    capturePreviewScreenshot: async () => {
      if (!supportsImages) {
        throw new Error(
          `${modelLabel} does not advertise image input support on OpenRouter. Use inspect_preview instead.`,
        );
      }
      const capture = previewHandle.previewScreenshotCapturer.current;
      if (!capture) {
        throw new Error("The live preview is not mounted.");
      }
      return capture();
    },
  };
}
