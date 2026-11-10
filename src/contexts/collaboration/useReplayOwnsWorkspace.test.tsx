import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../../core/src";
import type { EditorActorRef } from "../../core/src/useNextEditor";
import { NextEditorActorContext } from "../NextEditorActorContext";
import { useReplayOwnsWorkspace } from "./useReplayOwnsWorkspace";

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

describe("useReplayOwnsWorkspace", () => {
  it("reports a replay from the moment it starts loading until it is unloaded", async () => {
    let actor: EditorActorRef | undefined;
    let result: ReturnType<typeof useReplayOwnsWorkspace> | undefined;
    const readers = new Set<() => boolean>();
    function Probe() {
      actor = NextEditorActorContext.useActorRef();
      result = useReplayOwnsWorkspace();
      readers.add(result.readReplayOwnsWorkspace);
      return null;
    }
    render(
      <NextEditorActorContext.Provider options={{ input: { editorRef: { current: null } } }}>
        <Probe />
      </NextEditorActorContext.Provider>,
    );
    expect(result!.replayOwnsWorkspace).toBe(false);
    expect(result!.readReplayOwnsWorkspace()).toBe(false);

    // The reader sees the load start at once, before the render that updates
    // the flag: a load's own transitions write its opening frame.
    let readDuringLoad = false;
    let renderedDuringLoad = true;
    act(() => {
      actor!.send({ type: "LOAD_RECORDING", recording: lesson });
      readDuringLoad = result!.readReplayOwnsWorkspace();
      renderedDuringLoad = result!.replayOwnsWorkspace;
    });
    expect(readDuringLoad).toBe(true);
    expect(renderedDuringLoad).toBe(false);

    await waitFor(() => expect(actor!.getSnapshot().matches({ playback: "ready" })).toBe(true));
    expect(result!.replayOwnsWorkspace).toBe(true);
    expect(result!.readReplayOwnsWorkspace()).toBe(true);

    act(() => actor!.send({ type: "UNLOAD" }));
    expect(result!.replayOwnsWorkspace).toBe(false);
    expect(result!.readReplayOwnsWorkspace()).toBe(false);
    // One reader for the provider's lifetime, so the room effect keeps its socket.
    expect(readers.size).toBe(1);
  });
});
