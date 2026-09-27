import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import RecordingEditPanel from "./RecordingEditPanel";
import { NextEditorProvider } from "../contexts/NextEditorProvider";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import { SlidesStoreProvider } from "../contexts/SlidesStoreContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WhiteboardStoreProvider } from "../contexts/WhiteboardStoreContext";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import type { Recording } from "../core/src/types";
import type { NextEditorActions } from "../contexts/NextEditorContext";

const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

const take: Recording = {
  version: 4,
  id: "take",
  name: "Take",
  createdAt: 1,
  duration: 10_000,
  keyframeInterval: 120,
  frames: compressFrames(
    [0, 1_000, 8_000].map((timestamp, index) => ({
      timestamp,
      state: {
        content: "abc".slice(0, index + 1),
        selection,
        position: { lineNumber: 1, column: 1 },
        viewState: null,
      },
    })),
  ),
};

function Providers({ children }: PropsWithChildren) {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider allowAmbientStart={false}>
        <SlidesStoreProvider>
          <WhiteboardStoreProvider>
            <RuntimePanelStoreProvider>
              <PreviewAdapterHandleProvider>
                <NextEditorProvider recordingDrafts={false}>{children}</NextEditorProvider>
              </PreviewAdapterHandleProvider>
            </RuntimePanelStoreProvider>
          </WhiteboardStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom cannot draw; the waveform is drawn only when a context is available.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // A 100px-wide waveform: 1px is 100ms of this 10s take.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 80,
    right: 100,
    bottom: 80,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RecordingEditPanel", () => {
  it("cuts a selected stretch and hands on the loaded, shorter recording", async () => {
    const onApplied = vi.fn<(recording: Recording) => void>();
    const onClose = vi.fn<() => void>();
    const captured: { actions: NextEditorActions | null; current: Recording | null } = {
      actions: null,
      current: null,
    };
    function Capture() {
      captured.actions = useNextEditorActions();
      captured.current = useNextEditorMetadata().currentRecording;
      return null;
    }

    render(
      <Providers>
        <Capture />
        <RecordingEditPanel recording={take} onClose={onClose} onApplied={onApplied} />
      </Providers>,
    );
    act(() => captured.actions!.loadRecording(take));
    await waitFor(() => expect(captured.current?.id).toBe("take"));
    // No narration: cuts still apply to everything else.
    await screen.findByText(/No narration/);

    const waveform = document.querySelector("canvas")!.parentElement!;
    // jsdom has no pointer capture.
    waveform.setPointerCapture = vi.fn<(pointerId: number) => void>();
    fireEvent.pointerDown(waveform, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(waveform, { clientX: 70, pointerId: 1 });
    fireEvent.pointerUp(waveform, { clientX: 70, pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: /Cut selection/ }));

    expect(screen.getByText(/Removes 0:05/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Apply edits/ }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    const edited = onApplied.mock.calls[0][0];
    expect(edited.id).not.toBe("take");
    expect(edited.duration).toBeCloseTo(5_001, 0);
    expect(onClose).toHaveBeenCalled();
  });

  it("says while it reads the narration, and when it cannot", async () => {
    const responses: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => responses.push(resolve))),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <Providers>
        <RecordingEditPanel
          recording={{ ...take, audioUrl: "https://example.test/narration.wav" }}
          onClose={() => {}}
          onApplied={() => {}}
        />
      </Providers>,
    );
    expect(screen.getByText("Reading the narration…")).toBeInTheDocument();
    // Suggestions would cut through speech they cannot see.
    expect(screen.getByRole("button", { name: /Suggest dead-air cuts/ })).toBeDisabled();

    await act(async () => responses[0](new Response(null, { status: 500 })));

    expect(await screen.findByText("The narration could not be read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Suggest dead-air cuts/ })).toBeDisabled();
  });
});
