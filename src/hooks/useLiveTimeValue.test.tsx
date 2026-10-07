import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { useLiveTimeValue } from "./useNextEditorContext";

const lesson: Recording = {
  version: 4,
  id: "lesson",
  name: "Lesson",
  createdAt: 1,
  duration: 5_000,
  keyframeInterval: 120,
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

const Provider = ({ children }: PropsWithChildren) => (
  <NextEditorActorContext.Provider options={{ input: { editorRef: { current: null } } }}>
    {children}
  </NextEditorActorContext.Provider>
);

describe("useLiveTimeValue", () => {
  // The timer, chapter title, captions and play button show less than the exact time, so
  // they must not re-render on every tick the way useLiveTime's consumers do.
  it("re-renders when the derived value changes, not on every tick", async () => {
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return {
          seconds: useLiveTimeValue((currentTime) => Math.floor(currentTime / 1000)),
          actor: NextEditorActorContext.useActorRef(),
        };
      },
      { wrapper: Provider },
    );
    act(() => result.current.actor.send({ type: "LOAD_RECORDING", recording: lesson }));
    await waitFor(() =>
      expect(result.current.actor.getSnapshot().matches({ playback: "ready" })).toBe(true),
    );

    const rendersBefore = renders;
    for (const currentTime of [100, 400, 700, 999]) {
      act(() => result.current.actor.send({ type: "TICK", currentTime }));
    }
    expect(renders).toBe(rendersBefore);

    act(() => result.current.actor.send({ type: "TICK", currentTime: 1_016 }));
    expect(result.current.seconds).toBe(1);
    expect(renders).toBe(rendersBefore + 1);
  });
});
