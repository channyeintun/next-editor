import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src";
import type { EditorActorRef } from "../core/src/useNextEditor";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { useNextEditorMetadata } from "./useNextEditorContext";

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

describe("useNextEditorMetadata", () => {
  // A streamed lesson replaces the recording object on every delta; the flag-only
  // consumers (WhiteboardPanel, AgentPanel, CollaborationProvider) must sit those out.
  it("re-renders a selecting caller only when what it picks changes", async () => {
    const renders = { whole: 0, picked: 0 };
    let actor: EditorActorRef | undefined;
    const Whole = () => {
      renders.whole += 1;
      actor = NextEditorActorContext.useActorRef();
      useNextEditorMetadata();
      return null;
    };
    const Picked = () => {
      renders.picked += 1;
      useNextEditorMetadata((m) => ({ isReplayLoaded: m.isReplayLoaded, isPlaying: m.isPlaying }));
      return null;
    };
    render(
      <NextEditorActorContext.Provider options={{ input: { editorRef: { current: null } } }}>
        <Whole />
        <Picked />
      </NextEditorActorContext.Provider>,
    );

    const pickedBefore = renders.picked;
    act(() => actor!.send({ type: "LOAD_RECORDING", recording: lesson }));
    await waitFor(() => expect(actor!.getSnapshot().matches({ playback: "ready" })).toBe(true));
    expect(renders.picked).toBeGreaterThan(pickedBefore);

    // What a streamed delta does to the recording: a new object, the flags unchanged.
    const before = { ...renders };
    act(() => actor!.send({ type: "EXTEND_RECORDING", recording: { ...lesson } }));
    expect(actor!.getSnapshot().context.recording).not.toBe(lesson);
    expect(renders.whole).toBe(before.whole + 1);
    expect(renders.picked).toBe(before.picked);
  });
});
