import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPreviewAdapterHandle } from "../../stores/previewAdapterHandle";
import type { PreviewInitialDocument } from "../../types/slides";
import { usePreviewPlaybackRegistration } from "./usePreviewPlaybackRegistration";

interface FakeReplayerInstance {
  pause: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const fakeRrweb = vi.hoisted(() => ({
  instances: [] as FakeReplayerInstance[],
}));

vi.mock("@rrweb/replay", () => ({
  Replayer: class FakeReplayer {
    readonly wrapper = document.createElement("div");
    readonly iframe = document.createElement("iframe");
    readonly pause = vi.fn<(offset?: number) => void>();
    readonly destroy = vi.fn<() => void>(() => this.wrapper.remove());

    constructor(_events: unknown[], config: { root: HTMLElement }) {
      this.wrapper.append(this.iframe);
      config.root.append(this.wrapper);
      fakeRrweb.instances.push(this);
    }
  },
}));

const seed: PreviewInitialDocument = {
  version: 2,
  time: 0,
  documentId: "doc-1",
  events: [
    { type: 4, timestamp: 0, data: {} },
    { type: 2, timestamp: 0, data: {} },
  ],
};

interface ReplayProps {
  isRrwebReplayActive: boolean;
  isPlaybackPreviewActive: boolean;
}

function renderRegistration() {
  const previewHandle = createPreviewAdapterHandle();
  const container = document.createElement("div");
  document.body.append(container);

  const view = renderHook(
    ({ isRrwebReplayActive, isPlaybackPreviewActive }: ReplayProps) =>
      usePreviewPlaybackRegistration({
        previewHandle,
        isPlaybackPreviewActive,
        isRuntimePreviewActive: false,
        isLiveRuntimePreviewActive: false,
        hasPreviewPatchReplay: true,
        isRrwebReplayActive,
        pendingInteractionRef: { current: null },
        lastRuntimeSnapshotRef: { current: "" },
        lastContentRef: { current: "" },
        scrollPositionRef: { current: { scrollTop: 0, scrollLeft: 0 } },
        routeRef: { current: "/" },
        sizeRef: { current: "medium" },
        isOpenRef: { current: true },
        modeRef: { current: "docked" },
        updateIframeContent: vi.fn<(content: string) => void>(),
        setSize: vi.fn<() => void>(),
        applyPreviewRoute: vi.fn<(route: string) => void>(),
        applyPreviewPanelState: vi.fn<() => void>(),
        lastRefreshKeyRef: { current: undefined },
        replayContainerRef: { current: container },
      }),
    { initialProps: { isRrwebReplayActive: true, isPlaybackPreviewActive: true } },
  );

  const applyReplay = (currentTime: number) =>
    previewHandle.patchReplayApplier.current?.({
      recordingId: "recording-1",
      currentTime,
      initialDocuments: [seed],
      patchBatches: [],
    });

  return { ...view, applyReplay };
}

afterEach(() => {
  fakeRrweb.instances.length = 0;
  document.body.replaceChildren();
});

describe("usePreviewPlaybackRegistration rrweb replay", () => {
  it("destroys the Replayer when its replay surface goes away (pause)", async () => {
    const { applyReplay, rerender } = renderRegistration();
    applyReplay(100);
    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(1));

    // Pausing unmounts the replay container; the recording still has rrweb data
    // and no live runtime takes over.
    rerender({ isRrwebReplayActive: false, isPlaybackPreviewActive: false });

    expect(fakeRrweb.instances[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the Replayer on unmount", async () => {
    const { applyReplay, unmount } = renderRegistration();
    applyReplay(100);
    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(1));

    unmount();

    expect(fakeRrweb.instances[0]?.destroy).toHaveBeenCalledOnce();
  });
});
