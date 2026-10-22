import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreviewEvent } from "../../core/src";
import { IFRAME_INTERACTION_MESSAGE_TYPE } from "../../core/src/utils/iframeInteractionProtocol";
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
  const handlePreviewEvent = vi.fn<(event: PreviewEvent) => void>();

  renderHook(() =>
    usePreviewMessageBridge({
      iframeRef: { current: iframe },
      effectiveRuntimePreviewUrl,
      isRecordingRef: { current: true },
      handlePreviewEventRef: { current: handlePreviewEvent },
      handlePreviewInitialDocumentRef: { current: handlePreviewInitialDocument },
      handlePreviewPatchBatchRef: { current: handlePreviewPatchBatch },
      recordedPreviewInitialDocumentIdRef: { current: null },
      lastRuntimeSnapshotRef: { current: "" },
      scrollPositionRef: { current: { scrollTop: 0, scrollLeft: 0 } },
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

  return {
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    postFromPreview,
  };
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

describe("usePreviewMessageBridge scroll recording", () => {
  const documentScroll = (data: object) => ({
    type: "scroll",
    targetTag: "BODY",
    data: { scrollLeft: 0, isDocument: true, ...data },
  });

  it("records how far the page could scroll with a document scroll", () => {
    const { handlePreviewEvent, postFromPreview } = renderRecordingBridge(null);

    postFromPreview(
      IFRAME_INTERACTION_MESSAGE_TYPE,
      documentScroll({ scrollTop: 423, maxScrollTop: 423, maxScrollLeft: 0 }),
    );

    expect(handlePreviewEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "preview_scroll",
        scrollTop: 423,
        scrollLeft: 0,
        maxScrollTop: 423,
        maxScrollLeft: 0,
      }),
    );
  });

  it("records a scroll from a preview script that does not report it, and ignores junk", () => {
    const { handlePreviewEvent, postFromPreview } = renderRecordingBridge(null);

    postFromPreview(IFRAME_INTERACTION_MESSAGE_TYPE, documentScroll({ scrollTop: 40 }));
    postFromPreview(
      IFRAME_INTERACTION_MESSAGE_TYPE,
      documentScroll({ scrollTop: 50, maxScrollTop: "far", maxScrollLeft: Infinity }),
    );

    const [older, junk] = handlePreviewEvent.mock.calls.map(([event]) => event);
    expect(older).toMatchObject({ type: "preview_scroll", scrollTop: 40 });
    expect(older).not.toHaveProperty("maxScrollTop");
    expect(junk).toMatchObject({ type: "preview_scroll", scrollTop: 50 });
    expect(junk).not.toHaveProperty("maxScrollTop");
    expect(junk).not.toHaveProperty("maxScrollLeft");
  });
});
