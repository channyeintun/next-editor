import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyWhiteboardEvent,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../core/src/whiteboard";
import { createWhiteboardStore, type WhiteboardStoreInstance } from "../stores/whiteboardStore";

let store: WhiteboardStoreInstance;
// Every whiteboard event the recorder receives, in arrival order.
let recorded: WhiteboardEvent[] = [];
// The canvas the stand-in Excalidraw below is showing, and its onChange.
let canvas: { elements: WhiteboardElementJSON[]; report: () => void };

// A stand-in for Excalidraw 0.18 with the two habits behind the bug:
// - updateScene gives every element without an `index` one (syncInvalidIndices),
//   and that bumps its version, nonce and `updated` (mutateElement).
// - onChange fires on every commit (componentDidUpdate), so a render caused by a
//   new store scene reports the old canvas before the panel's effect pushes the
//   new one, and the push reports again.
vi.mock("@excalidraw/excalidraw", async () => {
  const { useLayoutEffect, useReducer, useState } = await import("react");
  let nonce = 1;
  const tidy = (elements: WhiteboardElementJSON[]) => {
    elements.forEach((element, position) => {
      if (typeof element.index === "string") return;
      Object.assign(element, {
        index: `a${position}`,
        version: element.version + 1,
        versionNonce: ++nonce,
        updated: Date.now(),
      });
    });
    return elements;
  };
  const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  const Empty = () => null;
  const MainMenu = Object.assign(Empty, {
    DefaultItems: {
      LoadScene: Empty,
      SaveToActiveFile: Empty,
      Export: Empty,
      SaveAsImage: Empty,
      SearchMenu: Empty,
      Help: Empty,
      ClearCanvas: Empty,
      ChangeCanvasBackground: Empty,
    },
    Separator: Empty,
  });
  const Excalidraw = ({
    excalidrawAPI,
    onChange,
    initialData,
  }: {
    excalidrawAPI: (api: unknown) => void;
    onChange: (elements: WhiteboardElementJSON[], state: unknown, files: unknown) => void;
    initialData: { elements: WhiteboardElementJSON[] };
  }) => {
    const [, rerender] = useReducer((count: number) => count + 1, 0);
    const [api] = useState(() => {
      canvas = { elements: tidy(initialData.elements), report: () => {} };
      return {
        updateScene: ({ elements }: { elements: WhiteboardElementJSON[] }) => {
          canvas.elements = tidy(elements);
          rerender();
        },
        getSceneElementsIncludingDeleted: () => canvas.elements,
        getAppState: () => appState,
      };
    });
    excalidrawAPI(api);
    canvas.report = () => onChange(canvas.elements, appState, {});
    useLayoutEffect(() => canvas.report());
    return null;
  };
  return { CaptureUpdateAction: { NEVER: "never" }, Excalidraw, MainMenu };
});
vi.mock("../contexts/WhiteboardStoreContext", () => ({
  useWhiteboardStore: () => ({ store }),
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({
    usesPlaybackModel: false,
    isInPlaybackSession: false,
    currentRecording: null,
  }),
  useNextEditorActions: () => ({
    handleWhiteboardEvent: (event: WhiteboardEvent) => recorded.push(event),
  }),
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => null,
}));

import { WhiteboardProvider } from "../contexts/WhiteboardContext";
import WhiteboardPanel from "./WhiteboardPanel";

// From the published next-editor-intro-mm recording (events 218-246): the
// filled box is drawn in over 11 steps, then the heading is typed into it over
// 11 steps. Authored assets carry no `index` and `updated: 1`.
const common = {
  angle: 0,
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  isDeleted: false,
  boundElements: null,
  link: null,
  locked: false,
  strokeColor: "#1971c2",
  updated: 1,
};
const BOX = {
  ...common,
  id: "hook-ne-box",
  type: "rectangle",
  x: 710,
  y: 240,
  width: 380,
  height: 190,
  backgroundColor: "#e7f5ff",
  seed: 1830853620,
  versionNonce: 564210797,
  version: 11,
};
const HEADING = {
  ...common,
  id: "hook-ne-heading",
  type: "text",
  x: 735,
  y: 258,
  width: 218,
  height: 46,
  backgroundColor: "transparent",
  seed: 43933463,
  versionNonce: 499417744,
  version: 11,
  text: "Next Editor",
  originalText: "Next Editor",
  fontSize: 36,
  fontFamily: 1,
  textAlign: "left",
  verticalAlign: "top",
  containerId: null,
  lineHeight: 1.25,
  autoResize: true,
};
const STEPS = 11;
const boxStep = (step: number): WhiteboardElementJSON => ({
  ...BOX,
  version: step,
  width: (BOX.width * step) / STEPS,
  height: (BOX.height * step) / STEPS,
});
const headingStep = (step: number): WhiteboardElementJSON => ({
  ...HEADING,
  version: step,
  text: HEADING.text.slice(0, step),
  originalText: HEADING.text.slice(0, step),
});
// The studio performer's draw frame (WHITEBOARD_DRAW_FRAME_MS).
const STEP_MS = 50;

function progress(element: WhiteboardElementJSON): number {
  return element.type === "text" ? String(element.text).length : Number(element.width);
}

describe("WhiteboardPanel recording a studio draw-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recorded = [];
    store = createWhiteboardStore();
    store.trigger.setScene({ scene: { ...EMPTY_WHITEBOARD_SCENE, isOpen: true } });
  });
  afterEach(() => vi.useRealTimers());

  it("records each drawn step once, never the canvas echoing it back", () => {
    render(
      <WhiteboardProvider>
        <WhiteboardPanel />
      </WhiteboardProvider>,
    );

    // What the studio driver does for each step: record it, then show it.
    const stepEvents = new Set<WhiteboardEvent>();
    let scene: WhiteboardSceneState = store.getSnapshot().context.scene;
    const steps = [
      ...Array.from({ length: STEPS }, (_, index) => boxStep(index + 1)),
      ...Array.from({ length: STEPS }, (_, index) => headingStep(index + 1)),
    ];
    for (const element of steps) {
      // The controller's 100 ms timer can fire after the driver has moved the
      // store on but before React has pushed that step into the canvas; moving
      // time in the same act() as the store update makes that happen every time.
      act(() => {
        const event: WhiteboardEvent = { timestamp: Date.now(), upserts: [element] };
        stepEvents.add(event);
        recorded.push(event);
        scene = applyWhiteboardEvent(scene, event);
        store.trigger.setScene({ scene });
        vi.advanceTimersByTime(STEP_MS);
      });
    }
    act(() => vi.advanceTimersByTime(500));

    const echoes = recorded.filter(
      (event) => !stepEvents.has(event) && (event.upserts || event.removedIds),
    );
    expect(echoes).toEqual([]);

    // What playback shows: fold the track in order. A stale echo made a piece
    // go back a step, and an echo's `index` lifted the heading above the box
    // while the plain steps put it below, so it flashed as it was typed.
    const problems: string[] = [];
    let folded = EMPTY_WHITEBOARD_SCENE;
    const reached = new Map<string, number>();
    recorded.forEach((event, position) => {
      folded = applyWhiteboardEvent(folded, event);
      const ids = folded.elements.map(({ id }) => id);
      if (ids.includes(HEADING.id) && ids.indexOf(HEADING.id) < ids.indexOf(BOX.id)) {
        problems.push(`event ${position}: heading under the box`);
      }
      for (const element of folded.elements) {
        if (progress(element) < (reached.get(element.id) ?? 0)) {
          problems.push(`event ${position}: ${element.id} went back`);
        }
        reached.set(element.id, Math.max(progress(element), reached.get(element.id) ?? 0));
      }
    });
    expect(problems).toEqual([]);

    // A real edit on that canvas is still recorded.
    act(() => {
      const heading = canvas.elements.find(({ id }) => id === HEADING.id)!;
      Object.assign(heading, { x: 800, version: heading.version + 1, versionNonce: 7 });
      canvas.report();
      vi.advanceTimersByTime(100);
    });
    expect(recorded.at(-1)?.upserts).toContainEqual(
      expect.objectContaining({ id: HEADING.id, x: 800, text: "Next Editor" }),
    );
  });
});
