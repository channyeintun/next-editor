import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_DOCK_MAX_WIDTH,
  PREVIEW_DOCK_MIN_WIDTH,
  PreviewPanelProvider,
  usePreviewPanel,
} from "./PreviewPanelContext";
import {
  PreviewAdapterHandleProvider,
  usePreviewAdapterHandle,
} from "./PreviewAdapterHandleContext";
import type { PreviewAdapterHandle } from "../stores/previewAdapterHandle";

describe("PreviewPanelProvider", () => {
  // NextEditorProvider's applyWorkspaceSnapshot replays recorded dock resizes
  // as deltas through the preview adapter handle.
  it("exposes a clamped dock-width delta applier while mounted", () => {
    const captured: { handle: PreviewAdapterHandle | null; dockWidth: number } = {
      handle: null,
      dockWidth: 0,
    };
    function Capture() {
      captured.handle = usePreviewAdapterHandle();
      captured.dockWidth = usePreviewPanel().dockWidth;
      return null;
    }
    const view = render(
      <PreviewAdapterHandleProvider>
        <PreviewPanelProvider>
          <Capture />
        </PreviewPanelProvider>
      </PreviewAdapterHandleProvider>,
    );
    const applyDelta = captured.handle?.dockWidthDeltaApplier.current;
    if (!applyDelta) throw new Error("Expected the dock-width applier to be registered");

    act(() => applyDelta(-10_000));
    expect(captured.dockWidth).toBe(PREVIEW_DOCK_MIN_WIDTH);
    act(() => applyDelta(10_000));
    expect(captured.dockWidth).toBeLessThanOrEqual(PREVIEW_DOCK_MAX_WIDTH);
    expect(captured.dockWidth).toBeGreaterThan(PREVIEW_DOCK_MIN_WIDTH);

    const handle = captured.handle;
    view.unmount();
    expect(handle?.dockWidthDeltaApplier.current).toBeNull();
  });
});
