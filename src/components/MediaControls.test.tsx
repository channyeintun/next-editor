import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import MediaControls from "./MediaControls";
import { NextEditorProvider } from "../contexts/NextEditorProvider";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import { SlidesStoreProvider } from "../contexts/SlidesStoreContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WhiteboardStoreProvider } from "../contexts/WhiteboardStoreContext";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { CaptionStoreProvider } from "../contexts/CaptionStoreContext";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import type { Recording } from "../core/src/types";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type { CaptionGenerationState } from "../hooks/useCaptionGeneration";

// Captioning runs a speech model; here it only needs to end the way a failed job does.
const generation = vi.hoisted(() => ({ fail: null as ((message: string) => void) | null }));
vi.mock("../hooks/useCaptionGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useCaptionGeneration")>();
  const { useState } = await import("react");
  return {
    ...actual,
    useCaptionGeneration: () => {
      const [state, setState] = useState<CaptionGenerationState>({ status: "idle" });
      generation.fail = (message) => setState({ status: "failed", message });
      return { state, start: async () => {}, cancel: () => setState({ status: "idle" }) };
    },
  };
});

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

const lesson: Recording = {
  version: 4,
  id: "lesson",
  name: "Lesson",
  createdAt: 1,
  duration: 60_000,
  keyframeInterval: 120,
  frames: compressFrames(
    [0, 30_000, 60_000].map((timestamp, index) => ({
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
                <NextEditorProvider recordingDrafts={false}>
                  <CaptionStoreProvider>{children}</CaptionStoreProvider>
                </NextEditorProvider>
              </PreviewAdapterHandleProvider>
            </RuntimePanelStoreProvider>
          </WhiteboardStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}

const seen: { actions: NextEditorActions | null; loaded: Recording | null } = {
  actions: null,
  loaded: null,
};

function Player({ large = false, recordMode = false }: { large?: boolean; recordMode?: boolean }) {
  seen.actions = useNextEditorActions();
  seen.loaded = useNextEditorMetadata().currentRecording;
  return <MediaControls recordMode={recordMode} large={large} />;
}

/** The learner's player bar with the lesson loaded. */
async function renderPlayer({ large = false }: { large?: boolean } = {}) {
  const view = render(
    <Providers>
      <Player large={large} />
    </Providers>,
  );
  act(() => seen.actions!.loadRecording(lesson));
  await waitFor(() => {
    if (seen.loaded?.id !== "lesson") throw new Error("The lesson has not loaded yet");
  });
  return view;
}

/** A file input the bar opens with click(); it has no role or name of its own. */
const filePicker = (container: HTMLElement, accept: string) => {
  const input = container.querySelector<HTMLInputElement>(
    `input[type="file"][accept^="${accept}"]`,
  );
  if (!input) throw new Error(`No file picker accepting ${accept}`);
  return input;
};

const playedFill = () =>
  screen
    .getByRole("slider", { name: "Playback progress" })
    .querySelector<HTMLElement>(".next-editor-progress-bar");

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("MediaControls", () => {
  it("keeps the large bar's played fill distinct from its track", async () => {
    // The large bar is as tall as its thumb, so the fill's edge is all that shows the
    // position: blue-300 on the slate-600 track is 4.2:1 (blue-500 was 2.06:1).
    await renderPlayer({ large: true });
    expect(playedFill()).toHaveStyle({ backgroundColor: "#93c5fd" });
  });

  it("keeps the default bar's blue, where the thumb stands out above the thin bar", async () => {
    await renderPlayer();
    expect(playedFill()).toHaveStyle({ backgroundColor: "#3b82f6" });
  });

  it("opens the caption picker from Import captions without a hidden Tab stop of its own", async () => {
    const { container } = await renderPlayer();
    const picker = filePicker(container, ".vtt");
    // Out of layout (display: none), so Tab never lands on it; an sr-only input took focus
    // with its focus ring clipped away.
    expect(picker).toHaveClass("hidden");
    expect(picker).not.toHaveClass("sr-only");
    const open = vi.spyOn(picker, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Import captions…" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens the narration file picker from the File option without a Tab stop of its own", () => {
    // The author's bar before a take: the audio-source row is showing.
    const { container } = render(
      <Providers>
        <Player recordMode />
      </Providers>,
    );
    const picker = filePicker(container, "audio/");
    expect(picker).toHaveClass("hidden");
    expect(picker).not.toHaveClass("sr-only");
    const open = vi.spyOn(picker, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("announces a caption file it could not import", async () => {
    const { container } = await renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The picker has closed and focus is still on Import captions…: only an alert is heard.
    // jsdom's File has no text(); a browser's reads the same words.
    const notCaptions = Object.assign(
      new File(["just some notes"], "notes.vtt", { type: "text/vtt" }),
      { text: async () => "just some notes" },
    );
    fireEvent.change(filePicker(container, ".vtt"), { target: { files: [notCaptions] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'No captions found in "notes.vtt" — expected WebVTT or SRT.',
    );
  });

  it("announces captioning that failed", async () => {
    await renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => generation.fail!("The narration could not be loaded (404)."));
    expect(screen.getByRole("alert")).toHaveTextContent("The narration could not be loaded (404).");
  });
});
