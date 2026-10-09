import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  chapterTarget,
  isCharacterKey,
  isPlayerKeyTarget,
  playerShortcutFor,
  usePlayerShortcuts,
} from "./usePlayerShortcuts";
import { playbackSettingsStore } from "../stores/playbackSettingsStore";
import { NextEditorProvider } from "../contexts/NextEditorProvider";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import { SlidesStoreProvider } from "../contexts/SlidesStoreContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WhiteboardStoreProvider } from "../contexts/WhiteboardStoreContext";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import {
  useLiveTime,
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "./useNextEditorContext";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import type { Recording } from "../core/src/types";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import { CaptionStoreProvider } from "../contexts/CaptionStoreContext";
import { useCaptionStore } from "./useCaptionStore";
import ProgressBar from "../components/ProgressBar";

const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

describe("playerShortcutFor", () => {
  it("maps the video-player keys", () => {
    expect(playerShortcutFor(key(" "))).toEqual({ type: "togglePlay" });
    expect(playerShortcutFor(key("k"))).toEqual({ type: "togglePlay" });
    expect(playerShortcutFor(key("ArrowLeft"))).toEqual({ type: "seekBy", ms: -5000 });
    expect(playerShortcutFor(key("L"))).toEqual({ type: "seekBy", ms: 10000 });
    expect(playerShortcutFor(key("."))).toEqual({ type: "stepBy", ms: 1000 });
    expect(playerShortcutFor(key(">"))).toEqual({ type: "speedBy", delta: 0.25 });
    expect(playerShortcutFor(key("["))).toEqual({ type: "chapter", direction: -1 });
    expect(playerShortcutFor(key("7"))).toEqual({ type: "seekToFraction", fraction: 0.7 });
    expect(playerShortcutFor(key("End"))).toEqual({ type: "seekToEnd" });
    expect(playerShortcutFor(key("?"))).toEqual({ type: "toggleHelp" });
  });

  it("leaves other keys, and every key with a modifier, alone", () => {
    expect(playerShortcutFor(key("x"))).toBeNull();
    expect(playerShortcutFor(key("Enter"))).toBeNull();
    expect(playerShortcutFor(key("k", { metaKey: true }))).toBeNull();
    expect(playerShortcutFor(key("ArrowLeft", { altKey: true }))).toBeNull();
    expect(playerShortcutFor(key("c", { ctrlKey: true }))).toBeNull();
  });
});

describe("isCharacterKey", () => {
  it("counts letters, numbers and punctuation, but not Space or named keys", () => {
    for (const value of ["k", "M", "5", ",", ">", "[", "?"])
      expect(isCharacterKey(value)).toBe(true);
    for (const value of [" ", "ArrowLeft", "Home", "End", "Enter", "Escape"])
      expect(isCharacterKey(value)).toBe(false);
  });
});

describe("isPlayerKeyTarget", () => {
  const within = (html: string, selector: string) => {
    document.body.innerHTML = html;
    return document.querySelector(selector);
  };

  it("takes keys on the page and on the player's buttons", () => {
    expect(isPlayerKeyTarget(document.body, "k")).toBe(true);
    expect(isPlayerKeyTarget(within("<button>Play</button>", "button"), "ArrowLeft")).toBe(true);
  });

  it("leaves Space on a button to the button", () => {
    expect(isPlayerKeyTarget(within("<button>Settings</button>", "button"), " ")).toBe(false);
  });

  it("never takes keys from places that are typed in or have keys of their own", () => {
    for (const [html, selector] of [
      ["<input>", "input"],
      ["<textarea></textarea>", "textarea"],
      ["<div class='monaco-editor'><div class='view-lines'></div></div>", ".view-lines"],
      ["<div class='xterm'><span></span></div>", "span"],
      ["<div class='excalidraw'><canvas></canvas></div>", "canvas"],
      ["<div contenteditable='true'><p></p></div>", "p"],
      ["<div role='dialog'><button>OK</button></div>", "button"],
      ["<div role='menu'><button>Item</button></div>", "button"],
      ["<div role='separator' tabindex='0'></div>", "div"],
    ]) {
      expect(isPlayerKeyTarget(within(html, selector), "k")).toBe(false);
    }
  });
});

describe("chapterTarget", () => {
  const chapters = [
    { time: 0, title: "Intro" },
    { time: 10_000, title: "Setup" },
    { time: 30_000, title: "Build" },
  ];

  it("goes to the next chapter, if there is one", () => {
    expect(chapterTarget(chapters, 12_000, 1)).toBe(30_000);
    expect(chapterTarget(chapters, 31_000, 1)).toBeNull();
  });

  it("goes back to the chapter's start, or to the one before when just past it", () => {
    expect(chapterTarget(chapters, 15_000, -1)).toBe(10_000);
    expect(chapterTarget(chapters, 11_000, -1)).toBe(0);
    expect(chapterTarget(chapters, 500, -1)).toBe(0);
  });

  it("has nowhere to go without chapters", () => {
    expect(chapterTarget([], 5_000, 1)).toBeNull();
    expect(chapterTarget([], 5_000, -1)).toBeNull();
  });
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
  chapters: [
    { time: 0, title: "Intro" },
    { time: 20_000, title: "Setup" },
    { time: 45_000, title: "Build" },
  ],
  captions: [{ id: "en", language: "en", cues: [{ start: 0, end: 1_000, text: "Hi" }] }],
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

describe("usePlayerShortcuts", () => {
  const seen: {
    actions: NextEditorActions | null;
    loaded: Recording | null;
    time: number;
    speed: number;
    volume: number;
    captions: boolean;
    shortcuts: ReturnType<typeof usePlayerShortcuts> | null;
  } = {
    actions: null,
    loaded: null,
    time: 0,
    speed: 1,
    volume: 1,
    captions: false,
    shortcuts: null,
  };

  function Player() {
    seen.actions = useNextEditorActions();
    seen.loaded = useNextEditorMetadata().currentRecording;
    seen.time = useLiveTime();
    const playback = useNextEditorPlayback();
    seen.speed = playback.playbackSpeed;
    seen.volume = playback.volume;
    seen.captions = useCaptionStore().enabled;
    seen.shortcuts = usePlayerShortcuts();
    return (
      <>
        <input aria-label="field" />
        {/* The player bar's seek slider, which takes the arrows, Home and End itself. */}
        <ProgressBar
          progress={0}
          duration={lesson.duration}
          currentTime={seen.time}
          onSeek={(time) => seen.actions!.seekTo(time)}
        />
      </>
    );
  }

  const press = (value: string, target: Element = document.body) =>
    act(() => {
      fireEvent.keyDown(target, { key: value });
    });

  beforeEach(async () => {
    window.localStorage.clear();
    // Keys resume the page's audio context, as a click on play does; jsdom has none.
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        resume() {
          return Promise.resolve();
        }
      },
    );
    render(
      <Providers>
        <Player />
      </Providers>,
    );
    act(() => seen.actions!.loadRecording(lesson));
    await waitFor(() => {
      if (seen.loaded?.id !== "lesson") throw new Error("The lesson has not loaded yet");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    playbackSettingsStore.trigger.setCharacterShortcuts({ enabled: true });
    window.localStorage.clear();
  });

  it("seeks by keys, within the lesson", async () => {
    press("ArrowRight");
    await waitFor(() => expect(seen.time).toBe(5_000));
    press("l");
    await waitFor(() => expect(seen.time).toBe(15_000));
    press("5");
    await waitFor(() => expect(seen.time).toBe(30_000));
    press("End");
    await waitFor(() => expect(seen.time).toBe(60_000));
    press("ArrowRight");
    await waitFor(() => expect(seen.time).toBe(60_000));
    press("Home");
    await waitFor(() => expect(seen.time).toBe(0));
    press("ArrowLeft");
    await waitFor(() => expect(seen.time).toBe(0));
  });

  it("moves between chapters and says which one it reached", async () => {
    press("]");
    await waitFor(() => expect(seen.time).toBe(20_000));
    expect(seen.shortcuts?.feedback?.text).toBe("Setup");
    press("]");
    await waitFor(() => expect(seen.time).toBe(45_000));
    press("[");
    await waitFor(() => expect(seen.time).toBe(20_000));
  });

  it("changes speed in steps within the player's range, and remembers it", async () => {
    press(">");
    await waitFor(() => expect(seen.speed).toBe(1.25));
    expect(seen.shortcuts?.feedback?.text).toBe("1.25×");
    for (let index = 0; index < 6; index++) press(">");
    await waitFor(() => expect(seen.speed).toBe(2));
    expect(window.localStorage.getItem("playback-speed")).toBe("2");
  });

  it("mutes and unmutes to the level before", async () => {
    act(() => seen.actions!.setVolume(0.6));
    await waitFor(() => expect(seen.volume).toBe(0.6));
    press("m");
    await waitFor(() => expect(seen.volume).toBe(0));
    press("M");
    await waitFor(() => expect(seen.volume).toBe(0.6));
  });

  it("turns captions on and off", async () => {
    press("c");
    await waitFor(() => expect(seen.captions).toBe(true));
    expect(seen.shortcuts?.feedback?.text).toBe("Captions on");
    press("c");
    await waitFor(() => expect(seen.captions).toBe(false));
  });

  it("keeps one key listener while the lesson is loaded, whatever the keys change", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const bubbleKeydown = (calls: unknown[][]) =>
      calls.filter(([type, , options]) => type === "keydown" && !options);

    press(">");
    await waitFor(() => expect(seen.speed).toBe(1.25));
    press("m");
    await waitFor(() => expect(seen.volume).toBe(0));
    press("c");
    await waitFor(() => expect(seen.captions).toBe(true));

    expect(bubbleKeydown(addListener.mock.calls)).toHaveLength(0);
    expect(bubbleKeydown(removeListener.mock.calls)).toHaveLength(0);
  });

  it("ignores letter, number and punctuation keys when single-key shortcuts are off", async () => {
    act(() => playbackSettingsStore.trigger.setCharacterShortcuts({ enabled: false }));
    press("m");
    press("5");
    press("]");
    press("?");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.volume).toBe(1);
    expect(seen.time).toBe(0);
    expect(seen.shortcuts?.helpOpen).toBe(false);

    // Arrows, Home and End are not character keys, so keyboard seeking still works.
    press("ArrowRight");
    await waitFor(() => expect(seen.time).toBe(5_000));
    press("End");
    await waitFor(() => expect(seen.time).toBe(60_000));

    // Turned back on, the same listener takes them again.
    act(() => playbackSettingsStore.trigger.setCharacterShortcuts({ enabled: true }));
    press("m");
    await waitFor(() => expect(seen.volume).toBe(0));
  });

  it("opens the shortcuts with ?", async () => {
    press("?");
    await waitFor(() => expect(seen.shortcuts?.helpOpen).toBe(true));
  });

  it("lets the focused seek bar take its own keys, so each press seeks once", async () => {
    const bar = screen.getByRole("slider", { name: "Playback progress" });
    bar.focus();

    // Were the window shortcut to act as well, each arrow would move 10 s, not 5 s.
    press("ArrowRight", bar);
    await waitFor(() => expect(seen.time).toBe(5_000));
    press("ArrowRight", bar);
    await waitFor(() => expect(seen.time).toBe(10_000));
    press("ArrowLeft", bar);
    await waitFor(() => expect(seen.time).toBe(5_000));
    press("End", bar);
    await waitFor(() => expect(seen.time).toBe(60_000));
    press("Home", bar);
    await waitFor(() => expect(seen.time).toBe(0));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.time).toBe(0);
  });

  it("leaves keys typed in a field, and keys another handler took, alone", async () => {
    press("ArrowRight", document.querySelector("input")!);
    press("5", document.querySelector("input")!);

    const taken = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    taken.preventDefault();
    act(() => {
      document.body.dispatchEvent(taken);
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.time).toBe(0);
  });
});
