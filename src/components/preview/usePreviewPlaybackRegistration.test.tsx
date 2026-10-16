import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPreviewAdapterHandle } from "../../stores/previewAdapterHandle";
import type { PreviewDomPatchBatch, PreviewInitialDocument } from "../../types/slides";
import type { WorkspaceFile } from "../../types/workspace";
import { createWorkspaceFile } from "../../types/workspaceFiles";
import { usePreviewPlaybackRegistration } from "./usePreviewPlaybackRegistration";

interface FakeReplayerInstance {
  pause: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  addEvent: ReturnType<typeof vi.fn>;
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
    readonly addEvent = vi.fn<(event: unknown) => void>();

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

function renderRegistration({
  initialDocument = seed,
  readWorkspaceFile = () => null,
}: {
  initialDocument?: PreviewInitialDocument;
  readWorkspaceFile?: (path: string) => WorkspaceFile | null;
} = {}) {
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
        readWorkspaceFile,
      }),
    { initialProps: { isRrwebReplayActive: true, isPlaybackPreviewActive: true } },
  );

  // The recording's preview tracks; streaming appends to them in place.
  const tracks = {
    initialDocuments: [initialDocument] as PreviewInitialDocument[],
    patchBatches: [] as PreviewDomPatchBatch[],
  };
  const applyReplay = (currentTime: number) =>
    previewHandle.patchReplayApplier.current?.({
      recordingId: "recording-1",
      currentTime,
      ...tracks,
    });

  return { ...view, applyReplay, tracks };
}

// A batch the host received at `time` whose one event the preview stamped `timestamp`.
const batch = (time: number, timestamp: number): PreviewDomPatchBatch => ({
  version: 2,
  time,
  source: "runtime-preview",
  documentId: "doc-1",
  events: [{ type: 3, timestamp, data: {} }],
});

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

  it("hands batches streamed in after the build to the live Replayer", async () => {
    const { applyReplay, tracks } = renderRegistration();
    tracks.patchBatches.push(batch(100, 100));
    applyReplay(150);
    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(1));

    tracks.patchBatches.push(batch(200, 200));
    applyReplay(210);

    expect(fakeRrweb.instances).toHaveLength(1);
    expect(fakeRrweb.instances[0]?.addEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 3, timestamp: 200 }),
    );
  });

  it("rebuilds when a streamed batch re-times the events already built", async () => {
    const { applyReplay, tracks } = renderRegistration();
    tracks.patchBatches.push(batch(100, 100));
    applyReplay(150);
    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(1));

    // Its preview clock leads the recording clock by more than any built
    // segment's, so every event shifts.
    tracks.patchBatches.push(batch(250, 300));
    applyReplay(260);

    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(2));
    expect(fakeRrweb.instances[0]?.destroy).toHaveBeenCalledOnce();
    expect(fakeRrweb.instances[0]?.addEvent).not.toHaveBeenCalled();
  });

  it("rewrites a streamed batch against the <style>s an earlier chunk recorded", async () => {
    const host = "https://abc--5173--2ed8f36d.local-corp.webcontainer-api.io";
    const logo = createWorkspaceFile("public/logo.svg", "<svg/>");
    const style = { type: 2, tagName: "style", attributes: {}, childNodes: [], id: 3 };
    const { applyReplay, tracks } = renderRegistration({
      initialDocument: {
        ...seed,
        events: [
          { type: 4, timestamp: 0, data: { href: `${host}/` } },
          { type: 2, timestamp: 0, data: { node: { type: 0, id: 1, childNodes: [style] } } },
        ],
      },
      readWorkspaceFile: (path) => (path === logo.path ? logo : null),
    });
    applyReplay(50);
    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(1));

    // Vite replacing the <style>'s text on a CSS edit.
    const text = { type: 3, textContent: `a { background: url("${host}/logo.svg"); }`, id: 9 };
    tracks.patchBatches.push({
      ...batch(100, 100),
      events: [
        {
          type: 3,
          timestamp: 100,
          data: {
            source: 0,
            texts: [],
            attributes: [],
            removes: [],
            adds: [{ parentId: 3, nextId: null, node: text }],
          },
        },
      ],
    });
    applyReplay(110);

    expect(fakeRrweb.instances[0]?.addEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adds: [
            expect.objectContaining({
              node: expect.objectContaining({
                textContent:
                  'a { background: url("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E"); }',
              }),
            }),
          ],
        }),
      }),
    );
  });

  it("destroys the Replayer on unmount", async () => {
    const { applyReplay, unmount } = renderRegistration();
    applyReplay(100);
    await vi.waitFor(() => expect(fakeRrweb.instances).toHaveLength(1));

    unmount();

    expect(fakeRrweb.instances[0]?.destroy).toHaveBeenCalledOnce();
  });
});
