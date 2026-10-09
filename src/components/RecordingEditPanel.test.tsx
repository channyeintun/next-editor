import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type PropsWithChildren } from "react";
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

    // Announced: the Cut button it was pressed on is disabled again.
    expect(screen.getByText(/Removes 0:05/)).toHaveRole("status");
    fireEvent.click(screen.getByRole("button", { name: /Apply edits/ }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    const edited = onApplied.mock.calls[0][0];
    expect(edited.id).not.toBe("take");
    expect(edited.duration).toBeCloseTo(5_001, 0);
    expect(onClose).toHaveBeenCalled();
  });

  it("selects a stretch from the keyboard by marking its edges at the playhead", async () => {
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
        <RecordingEditPanel recording={take} onClose={() => {}} onApplied={() => {}} />
      </Providers>,
    );
    act(() => captured.actions!.loadRecording(take));
    await waitFor(() => expect(captured.current?.id).toBe("take"));
    await screen.findByText(/No narration/);

    const cut = screen.getByRole("button", { name: /Cut selection/ });
    expect(cut).toBeDisabled();
    act(() => captured.actions!.seekTo(2_000));
    fireEvent.click(screen.getByRole("button", { name: "Start at playhead" }));
    act(() => captured.actions!.seekTo(7_000));
    fireEvent.click(screen.getByRole("button", { name: "End at playhead" }));
    // Each edge is announced as it is set.
    expect(screen.getByText("0:02–0:07")).toHaveRole("status");

    fireEvent.click(cut);
    expect(screen.getByText(/Removes 0:05/)).toBeInTheDocument();
    // Cut is disabled again with no selection, so focus goes back to the start edge.
    expect(cut).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start at playhead" })).toHaveFocus();
  });

  it("keeps focus in the panel as each edit is removed", async () => {
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
        <RecordingEditPanel recording={take} onClose={() => {}} onApplied={() => {}} />
      </Providers>,
    );
    act(() => captured.actions!.loadRecording(take));
    await waitFor(() => expect(captured.current?.id).toBe("take"));
    await screen.findByText(/No narration/);

    const cutBetween = (start: number, end: number) => {
      act(() => captured.actions!.seekTo(start));
      fireEvent.click(screen.getByRole("button", { name: "Start at playhead" }));
      act(() => captured.actions!.seekTo(end));
      fireEvent.click(screen.getByRole("button", { name: "End at playhead" }));
      fireEvent.click(screen.getByRole("button", { name: /Cut selection/ }));
    };
    cutBetween(1_000, 2_000);
    cutBetween(4_000, 6_000);

    const [first, second] = screen.getAllByRole("button", { name: "Remove this cut" });
    second.focus();
    fireEvent.click(second);
    // The removed button is gone: focus moves to the edit before it.
    expect(screen.getAllByRole("button", { name: "Remove this cut" })).toHaveLength(1);
    expect(first).toHaveFocus();

    fireEvent.click(first);
    // With no edit left before it, focus goes to where the next stretch starts.
    expect(screen.queryByRole("button", { name: "Remove this cut" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start at playhead" })).toHaveFocus();
  });

  it("takes focus when it opens and gives it back to the opener when it closes", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Edit
          </button>
          {open ? (
            <RecordingEditPanel
              recording={take}
              onClose={() => setOpen(false)}
              onApplied={() => {}}
            />
          ) : null}
        </>
      );
    }

    render(
      <Providers>
        <Harness />
      </Providers>,
    );
    const opener = screen.getByRole("button", { name: "Edit" });
    opener.focus();
    fireEvent.click(opener);

    // The panel comes before its opener in the page, so Tab alone would never reach it.
    expect(screen.getByRole("dialog", { name: "Edit recording" })).toHaveFocus();
    await screen.findByText(/No narration/);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("announces when there is no dead air to suggest", async () => {
    // Something happens every two seconds: no stretch is quiet for long enough to cut.
    const busy: Recording = {
      ...take,
      frames: compressFrames(
        [0, 2_000, 4_000, 6_000, 8_000].map((timestamp, index) => ({
          timestamp,
          state: {
            content: "abcde".slice(0, index + 1),
            selection,
            position: { lineNumber: 1, column: 1 },
            viewState: null,
          },
        })),
      ),
    };

    render(
      <Providers>
        <RecordingEditPanel recording={busy} onClose={() => {}} onApplied={() => {}} />
      </Providers>,
    );
    await screen.findByText(/No narration/);
    const region = screen.getByRole("dialog").querySelector('[aria-live="polite"]');
    // The live region is there, empty, before the message arrives.
    expect(region).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: /Suggest dead-air cuts/ }));

    expect(region).toHaveTextContent("No stretch of dead air long enough to cut.");
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
