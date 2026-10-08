import { act, render, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CursorRecordingEvent, Recording } from "../core/src";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { dispatchRecordedCursorVisibility } from "../core/src/utils/recordedCursorVisibility";
import Cursor from "./Cursor";

function lesson(cursorEvents: CursorRecordingEvent[]): Recording {
  return {
    version: 4,
    id: "lesson",
    name: "Lesson",
    createdAt: 1,
    duration: 10_000,
    keyframeInterval: 120,
    cursorEvents,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
        state: {
          content: "",
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: 1,
          },
          position: { lineNumber: 1, column: 1 },
          viewState: null,
        },
      },
    ],
  };
}

const Provider = ({ children }: PropsWithChildren) => (
  <NextEditorActorContext.Provider options={{ input: { editorRef: { current: null } } }}>
    {children}
  </NextEditorActorContext.Provider>
);

let actor: ReturnType<typeof NextEditorActorContext.useActorRef> | null = null;
const CaptureActor = () => {
  actor = NextEditorActorContext.useActorRef();
  return null;
};

// Animation frames run only when the test steps them.
let pendingFrame: FrameRequestCallback | null = null;
const stepFrame = (currentTime: number) => {
  act(() => actor!.send({ type: "TICK", currentTime }));
  const frame = pendingFrame;
  pendingFrame = null;
  act(() => frame?.(currentTime));
};

const overlay = () => document.querySelector<HTMLDivElement>('div[aria-hidden="true"]');
const glyph = () => overlay()?.lastElementChild as HTMLDivElement | null;

async function playLesson(cursorEvents: CursorRecordingEvent[]) {
  render(
    <Provider>
      <CaptureActor />
      <Cursor />
    </Provider>,
  );
  act(() => actor!.send({ type: "LOAD_RECORDING", recording: lesson(cursorEvents) }));
  await waitFor(() => expect(actor!.getSnapshot().matches({ playback: "ready" })).toBe(true));
  act(() => actor!.send({ type: "PLAY" }));
  await waitFor(() => expect(actor!.getSnapshot().matches({ playback: "playing" })).toBe(true));
}

describe("Cursor", () => {
  let animate: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    actor = null;
    pendingFrame = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      pendingFrame = null;
    });
    animate = vi.fn<() => void>();
    HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("shows a tap that falls between two frames as a click", async () => {
    await playLesson([
      { timestamp: 0, x: 50, y: 50, visible: true, flags: 0 },
      { timestamp: 300, x: 50, y: 50, visible: true, flags: 1 },
      { timestamp: 313, x: 50, y: 50, visible: true, flags: 0 },
    ]);

    stepFrame(290);
    expect(glyph()!.style.transform).toBe("");
    // The 13ms tap lies wholly between this frame and the last.
    stepFrame(320);
    expect(glyph()!.style.transform).toBe("scale(0.86)");
    expect(animate).toHaveBeenCalledTimes(1);
    // It reads as pressed only briefly.
    stepFrame(500);
    expect(glyph()!.style.transform).toBe("");
  });

  it("does not ring for a seek that lands in the middle of a drag", async () => {
    await playLesson([
      { timestamp: 0, x: 50, y: 50, visible: true, flags: 0 },
      { timestamp: 4_000, x: 50, y: 50, visible: true, flags: 1 },
      { timestamp: 4_016, x: 60, y: 50, visible: true, flags: 1 },
      { timestamp: 4_032, x: 70, y: 50, visible: true, flags: 0 },
    ]);

    stepFrame(100);
    stepFrame(4_020);

    // Pressed, because the button is down there — but no press happened.
    expect(glyph()!.style.transform).toBe("scale(0.86)");
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps drawing the arrow after a viewer's mid-playback hide and show", async () => {
    await playLesson([
      { timestamp: 0, x: 50, y: 50, visible: true },
      { timestamp: 5_000, x: 80, y: 90, visible: true },
    ]);
    stepFrame(100);
    expect(overlay()!.style.opacity).toBe("1");

    // A sidebar resize during playback hides the replayed arrow, then shows it.
    act(() => dispatchRecordedCursorVisibility({ x: 0, y: 0, visible: false }));
    expect(overlay()).toBeNull();
    act(() => dispatchRecordedCursorVisibility({ x: 0, y: 0, visible: true }));
    stepFrame(200);

    expect(overlay()!.style.opacity).toBe("1");
    expect(overlay()!.style.transform).toBe("translate3d(50px, 50px, 0)");
  });

  it("ignores a hide sent outside playback (the studio hiding its own pointer)", async () => {
    await playLesson([
      { timestamp: 0, x: 50, y: 50, visible: true },
      { timestamp: 5_000, x: 80, y: 90, visible: true },
    ]);
    act(() => actor!.send({ type: "PAUSE" }));
    act(() => dispatchRecordedCursorVisibility({ x: 0, y: 0, visible: false }));
    act(() => actor!.send({ type: "PLAY" }));
    await waitFor(() => expect(actor!.getSnapshot().matches({ playback: "playing" })).toBe(true));
    stepFrame(300);

    expect(overlay()!.style.opacity).toBe("1");
  });
});
