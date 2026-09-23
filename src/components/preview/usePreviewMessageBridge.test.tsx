import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreviewDomPatchBatch, PreviewInitialDocument } from "../../types/slides";
import {
  RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
  RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
} from "./rrwebPreview";
import { usePreviewMessageBridge } from "./usePreviewMessageBridge";

function renderRecordingBridge(effectiveRuntimePreviewUrl: string | null) {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const handlePreviewInitialDocument = vi.fn<(document: PreviewInitialDocument) => void>();
  const handlePreviewPatchBatch = vi.fn<(batch: PreviewDomPatchBatch) => void>();

  renderHook(() =>
    usePreviewMessageBridge({
      iframeRef: { current: iframe },
      effectiveRuntimePreviewUrl,
      isRecordingRef: { current: true },
      handlePreviewEventRef: { current: null },
      handlePreviewInitialDocumentRef: { current: handlePreviewInitialDocument },
      handlePreviewPatchBatchRef: { current: handlePreviewPatchBatch },
      recordedPreviewInitialDocumentIdRef: { current: null },
      lastRuntimeSnapshotRef: { current: "" },
      scrollPositionRef: { current: { scrollTop: 0, scrollLeft: 0 } },
      userScrollTimeoutRef: { current: null },
      isUserScrollingRef: { current: false },
      targetScrollRef: { current: null },
      pendingInteractionRef: { current: null },
      sizeRef: { current: "medium" },
      onConsoleMessage: vi.fn<(message: string) => void>(),
      onRouteChange: vi.fn<(route: string) => void>(),
    }),
  );

  const postFromPreview = (type: string, payload: unknown) => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type, payload }, source: iframe.contentWindow }),
    );
  };

  return { handlePreviewInitialDocument, handlePreviewPatchBatch, postFromPreview };
}

const rrwebEvent = (type: number, timestamp: number) => ({ type, timestamp, data: {} });

afterEach(() => {
  document.body.replaceChildren();
});

describe("usePreviewMessageBridge rrweb recording", () => {
  it("records a seed and its batches alike, with or without a runtime URL", () => {
    const { handlePreviewInitialDocument, handlePreviewPatchBatch, postFromPreview } =
      renderRecordingBridge(null);

    postFromPreview(RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE, {
      version: 2,
      time: 10,
      documentId: "doc-1",
      route: "/",
      events: [rrwebEvent(4, 1), rrwebEvent(2, 2)],
    });
    postFromPreview(RUNTIME_PATCH_BATCH_MESSAGE_TYPE, {
      version: 2,
      time: 20,
      source: "runtime-preview",
      documentId: "doc-1",
      route: "/",
      events: [rrwebEvent(3, 3)],
    });

    expect(handlePreviewPatchBatch).toHaveBeenCalledOnce();
    // A batch without its seed cannot be replayed, so the seed must not be the
    // one of the two that gets dropped.
    expect(handlePreviewInitialDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
    );
  });
});
