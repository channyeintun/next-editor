import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import type { WhiteboardEvent } from "../core/src/whiteboard";
import { whenCodeEditorLoaded } from "../components/codeEditorLoader";
import {
  prefetchWhiteboardPanel,
  prefetchWhiteboardPanelWhenIdle,
} from "../components/whiteboardPanelLoader";
import { useWhiteboardPanelPrefetch } from "./useWhiteboardPanelPrefetch";

// The real loaders import Monaco and Excalidraw.
vi.mock("../components/codeEditorLoader", () => ({
  whenCodeEditorLoaded: vi.fn<() => Promise<void>>(),
}));
vi.mock("../components/whiteboardPanelLoader", () => ({
  prefetchWhiteboardPanel: vi.fn<() => void>(),
  prefetchWhiteboardPanelWhenIdle: vi.fn<() => () => void>(),
}));

const cancelIdlePrefetch = vi.fn<() => void>();
let loadCodeEditorChunk: () => void;

const OPENS_BOARD: WhiteboardEvent[] = [
  { timestamp: 0, upserts: [] },
  { timestamp: 1500, isOpen: true },
];

function recordingWith(overrides: Partial<Recording>): Recording {
  return { id: "lesson", name: "Lesson", frames: [], ...overrides } as unknown as Recording;
}

/** A lesson that opens the board, with its narration downloaded. */
const narratedBoardLesson = recordingWith({
  whiteboardEvents: OPENS_BOARD,
  audioUrl: "https://example.com/lesson.ogg",
  audioBlob: new Blob(["ogg"], { type: "audio/ogg" }),
});

function renderPrefetch(recording: Recording | null, isPlaying = false) {
  return renderHook(
    ({ recording, isPlaying }) => useWhiteboardPanelPrefetch(recording, isPlaying),
    { initialProps: { recording, isPlaying } },
  );
}

/** Lets the code editor chunk's promise callbacks run. */
async function loadEditorChunk() {
  await act(async () => {
    loadCodeEditorChunk();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.mocked(whenCodeEditorLoaded).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        loadCodeEditorChunk = resolve;
      }),
  );
  vi.mocked(prefetchWhiteboardPanelWhenIdle).mockReturnValue(cancelIdlePrefetch);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useWhiteboardPanelPrefetch", () => {
  it("prefetches at idle once the editor chunk is in, for a lesson that opens the board", async () => {
    renderPrefetch(narratedBoardLesson);
    expect(prefetchWhiteboardPanelWhenIdle).not.toHaveBeenCalled();

    await loadEditorChunk();

    expect(prefetchWhiteboardPanelWhenIdle).toHaveBeenCalledTimes(1);
    expect(prefetchWhiteboardPanel).not.toHaveBeenCalled();
  });

  it("waits for the narration download first", async () => {
    const downloading = recordingWith({
      whiteboardEvents: OPENS_BOARD,
      audioUrl: "https://example.com/lesson.ogg",
    });
    const { rerender } = renderPrefetch(downloading);
    await act(async () => {
      await Promise.resolve();
    });
    expect(whenCodeEditorLoaded).not.toHaveBeenCalled();
    expect(prefetchWhiteboardPanelWhenIdle).not.toHaveBeenCalled();

    rerender({ recording: narratedBoardLesson, isPlaying: false });
    await loadEditorChunk();

    expect(prefetchWhiteboardPanelWhenIdle).toHaveBeenCalledTimes(1);
  });

  it("does not wait for narration a lesson does not have", async () => {
    renderPrefetch(recordingWith({ whiteboardEvents: OPENS_BOARD }));

    await loadEditorChunk();

    expect(prefetchWhiteboardPanelWhenIdle).toHaveBeenCalledTimes(1);
  });

  it("never prefetches for a lesson that never opens the board", async () => {
    renderPrefetch(
      recordingWith({
        whiteboardEvents: [{ timestamp: 0, isOpen: false }],
        audioBlob: new Blob(["ogg"]),
      }),
    );
    renderPrefetch(null);

    expect(whenCodeEditorLoaded).not.toHaveBeenCalled();
    expect(prefetchWhiteboardPanelWhenIdle).not.toHaveBeenCalled();
    expect(prefetchWhiteboardPanel).not.toHaveBeenCalled();
  });

  it("starts at once, rather than at idle, while the lesson plays", async () => {
    const { rerender } = renderPrefetch(narratedBoardLesson);

    rerender({ recording: narratedBoardLesson, isPlaying: true });
    await loadEditorChunk();

    expect(prefetchWhiteboardPanel).toHaveBeenCalledTimes(1);
    expect(prefetchWhiteboardPanelWhenIdle).not.toHaveBeenCalled();
  });

  it("cancels an idle prefetch that has not started when the lesson goes away", async () => {
    const { rerender } = renderPrefetch(narratedBoardLesson);
    await loadEditorChunk();

    rerender({ recording: null as unknown as Recording, isPlaying: false });

    expect(cancelIdlePrefetch).toHaveBeenCalledTimes(1);
  });

  it("leaves the download to the board's first opening on a data-saver connection", async () => {
    vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
    renderPrefetch(narratedBoardLesson, true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(whenCodeEditorLoaded).not.toHaveBeenCalled();
    expect(prefetchWhiteboardPanel).not.toHaveBeenCalled();
    expect(prefetchWhiteboardPanelWhenIdle).not.toHaveBeenCalled();
  });
});
