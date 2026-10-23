import { describe, expect, it } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import { editorMachine } from "./editorMachine";
import type { ViewerPanel } from "./viewerPanels";
import { createRecording } from "./testing/takeFixtures";
import type { Recording } from "../types";
import type { RuntimeRecordingSnapshot } from "../runtime";
import type { SlidePreviewState } from "../slides";
import {
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
  type WhiteboardSceneState,
} from "../whiteboard";

const element = (id: string) =>
  ({
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
  }) as WhiteboardElementJSON;

/** Runtime fields without terminal sessions: a valid checkpoint and a valid delta alike. */
type DockRecord = Omit<RuntimeRecordingSnapshot, "terminalSessions">;

const dock = (fields: Partial<DockRecord>): DockRecord => ({
  mode: "single-file",
  status: "ready",
  ...fields,
});

/**
 * Each panel's view is changed by the recording at 3000 ms and 5000 ms. At 1000 ms the
 * author draws, moves to another slide and the runtime prints, which change what is in
 * the panels but not how they are shown.
 */
function lesson(): Recording {
  return {
    ...createRecording(),
    duration: 10_000,
    whiteboardEvents: [
      { timestamp: 0, isOpen: true, upserts: [element("a")] },
      { timestamp: 1000, upserts: [element("b")] },
      { timestamp: 3000, isMaximized: true },
      { timestamp: 5000, isOpen: false },
    ],
    slides: [
      { id: "one", order: 0, content: "one", contentType: "html" },
      { id: "two", order: 1, content: "two", contentType: "html" },
    ],
    slideEvents: [
      { type: "slide_open", timestamp: 0, slideId: "one", isMaximized: true },
      { type: "slide_change", timestamp: 1000, slideId: "two" },
      { type: "slide_minimize", timestamp: 3000, slideId: "two" },
      { type: "slide_close", timestamp: 5000, slideId: "two" },
    ],
    runtimeEvents: [
      { timestamp: 0, snapshot: dock({ isCollapsed: false }) },
      { timestamp: 1000, delta: dock({ isCollapsed: false, lastOutput: "built" }) },
      { timestamp: 3000, delta: dock({ isCollapsed: true, lastOutput: "built" }) },
      { timestamp: 5000, delta: dock({ isCollapsed: false, lastOutput: "built" }) },
    ],
  };
}

/**
 * The machine with the app's three stores behind its hooks, as NextEditorProvider wires
 * them, and the viewer's controls, which change a store and then tell the machine, as the
 * app's providers do.
 */
async function startLesson(recording = lesson()) {
  const screen = {
    board: EMPTY_WHITEBOARD_SCENE as WhiteboardSceneState,
    deck: {
      isOpen: false,
      isMaximized: false,
      currentSlideId: null,
      indexv: 0,
    } as SlidePreviewState,
    liveDockCollapsed: false,
    replayedDock: null as RuntimeRecordingSnapshot | null,
  };

  const actor = createActor(editorMachine, {
    input: {
      editorRef: { current: null },
      getWhiteboardState: () => screen.board,
      applyWhiteboardState: (scene) => {
        screen.board = scene;
      },
      getSlideState: () => ({ previewState: screen.deck, currentSlideIndex: 0 }),
      // As applySlideRecordingState: fields a state leaves out keep their values.
      applySlideState: (state) => {
        screen.deck = {
          isOpen: state.isOpen,
          isMaximized: state.isMaximized ?? screen.deck.isMaximized,
          currentSlideId: state.currentSlideId ?? screen.deck.currentSlideId,
          indexv: state.indexv ?? screen.deck.indexv,
        };
      },
      getRuntimeSnapshot: () => dock({ isCollapsed: screen.liveDockCollapsed }),
      applyRuntimeSnapshot: (snapshot) => {
        screen.replayedDock = snapshot;
      },
    },
  }).start();
  actor.send({ type: "LOAD_RECORDING", recording });
  await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

  const told = (panel: ViewerPanel) => actor.send({ type: "VIEWER_PANEL_VIEW_CHANGED", panel });
  const viewer = {
    setBoard(view: Partial<Pick<WhiteboardSceneState, "isOpen" | "isMaximized">>) {
      screen.board = { ...screen.board, ...view };
      told("whiteboard");
    },
    setDeck(view: Pick<SlidePreviewState, "isOpen" | "isMaximized">) {
      screen.deck = { ...screen.deck, ...view };
      told("slides");
    },
    // As runtimePanelStore's setViewerCollapsed: the live dock and the replayed frame.
    setDockCollapsed(isCollapsed: boolean) {
      screen.liveDockCollapsed = isCollapsed;
      screen.replayedDock = screen.replayedDock && { ...screen.replayedDock, isCollapsed };
      told("runtimeDock");
    },
  };

  /** What the viewer sees of each panel. */
  const shown = () => ({
    board: `${screen.board.isOpen ? "open" : "closed"}${screen.board.isMaximized ? ", maximized" : ""}`,
    deck: screen.deck.isOpen && screen.deck.isMaximized ? "shown" : "hidden",
    dock: screen.replayedDock?.isCollapsed ? "collapsed" : "expanded",
  });

  const tick = (currentTime: number) => actor.send({ type: "TICK", currentTime });
  const holds = () => actor.getSnapshot().context.viewerPanelHolds;

  return { actor, screen, viewer, shown, tick, holds };
}

/** The viewer hides all three panels the recording shows at that moment. */
function hideAll(viewer: Awaited<ReturnType<typeof startLesson>>["viewer"]) {
  viewer.setBoard({ isOpen: false });
  viewer.setDeck({ isOpen: false, isMaximized: false });
  viewer.setDockCollapsed(true);
}

const HIDDEN = { board: "closed", deck: "hidden", dock: "collapsed" };

describe("the viewer's view of the replayed panels", () => {
  it("holds while the author works inside the panels, until the recording changes their view", async () => {
    const { actor, screen, viewer, shown, tick, holds } = await startLesson();
    actor.send({ type: "PLAY" });
    tick(500);
    expect(shown()).toEqual({ board: "open", deck: "shown", dock: "expanded" });

    hideAll(viewer);
    expect(shown()).toEqual(HIDDEN);

    // Drawing, a slide change and new output: the content follows, hidden.
    tick(1500);
    expect(shown()).toEqual(HIDDEN);
    expect(screen.board.elements.map(({ id }) => id).sort()).toEqual(["a", "b"]);
    expect(screen.deck.currentSlideId).toBe("two");
    expect(screen.replayedDock?.lastOutput).toBe("built");

    // The author maximizes the board, minimizes the deck and collapses the dock.
    tick(3500);
    expect(shown()).toEqual({ board: "open, maximized", deck: "hidden", dock: "collapsed" });
    expect(holds()).toEqual({});

    actor.stop();
  });

  it("lets the recording take over again after it changed the view, even into the same state", async () => {
    const { actor, viewer, shown, tick, holds } = await startLesson();
    actor.send({ type: "PLAY" });
    tick(3500);
    // The deck is minimized and the dock collapsed here; the viewer shows both.
    viewer.setDeck({ isOpen: true, isMaximized: true });
    viewer.setDockCollapsed(false);
    tick(4500);
    expect(shown()).toMatchObject({ deck: "shown", dock: "expanded" });

    // The author closes the deck and expands the dock: the dock looks the same as the
    // viewer's, but it is the recording's again.
    tick(5500);
    expect(shown()).toMatchObject({ deck: "hidden", dock: "expanded" });
    expect(holds()).toEqual({});

    actor.stop();
  });

  it("holds through a seek within the same stretch and ends with a seek out of it", async () => {
    const { actor, viewer, shown, holds } = await startLesson();
    actor.send({ type: "PLAY" });
    actor.send({ type: "SEEK", time: 500 });
    hideAll(viewer);

    actor.send({ type: "SEEK", time: 2500 });
    expect(shown()).toEqual(HIDDEN);

    actor.send({ type: "SEEK", time: 4000 });
    expect(shown()).toEqual({ board: "open, maximized", deck: "hidden", dock: "collapsed" });
    expect(holds()).toEqual({});

    // A seek back into the stretch does not bring the viewer's old view back.
    actor.send({ type: "SEEK", time: 2500 });
    expect(shown()).toEqual({ board: "open", deck: "shown", dock: "expanded" });

    actor.stop();
  });

  it("holds through pause and resume, and a choice made while paused holds on resume", async () => {
    const { actor, viewer, shown, tick } = await startLesson();
    actor.send({ type: "PLAY" });
    tick(500);
    viewer.setBoard({ isOpen: false });
    actor.send({ type: "PAUSE" });
    // Paused, the viewer hides the other two.
    viewer.setDeck({ isOpen: false, isMaximized: false });
    viewer.setDockCollapsed(true);

    // Resuming re-applies every track from scratch.
    actor.send({ type: "PLAY" });
    expect(shown()).toEqual(HIDDEN);
    tick(1500);
    expect(shown()).toEqual(HIDDEN);

    actor.stop();
  });

  it("treats a restart as a seek to the start", async () => {
    const { actor, viewer, shown, tick } = await startLesson();
    actor.send({ type: "PLAY" });
    tick(500);
    hideAll(viewer);

    // Made in the opening stretch, the view holds at the start.
    actor.send({ type: "STOP" });
    expect(shown()).toEqual(HIDDEN);

    actor.send({ type: "PLAY" });
    tick(3500);
    viewer.setBoard({ isOpen: false });
    // Made after the author's changes, it does not.
    actor.send({ type: "STOP" });
    expect(shown().board).toBe("open");

    actor.stop();
  });

  it("holds a choice made before the first play", async () => {
    const { actor, viewer, shown, tick } = await startLesson();
    hideAll(viewer);

    actor.send({ type: "PLAY" });
    tick(1500);
    expect(shown()).toEqual(HIDDEN);

    actor.stop();
  });

  it("starts every recording with every panel following it", async () => {
    const { actor, viewer, holds } = await startLesson();
    hideAll(viewer);
    expect(Object.keys(holds()).sort()).toEqual(["runtimeDock", "slides", "whiteboard"]);

    actor.send({ type: "LOAD_RECORDING", recording: lesson() });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    expect(holds()).toEqual({});

    hideAll(viewer);
    actor.send({ type: "UNLOAD" });
    expect(holds()).toEqual({});

    actor.stop();
  });

  it("holds nothing outside playback, so a take is not affected", async () => {
    const actor = createActor(editorMachine, { input: { editorRef: { current: null } } }).start();

    actor.send({ type: "VIEWER_PANEL_VIEW_CHANGED", panel: "whiteboard" });
    expect(actor.getSnapshot().context.viewerPanelHolds).toEqual({});

    actor.stop();
  });
});
