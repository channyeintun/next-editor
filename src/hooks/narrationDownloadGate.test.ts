import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import type { Recording } from "../core/src";
import { editorMachine } from "../core/src/machine/editorMachine";
import { whenCodeEditorLoaded } from "../components/codeEditorLoader";
import { whenNarrationMayDownload } from "./narrationDownloadGate";

// The real loader imports CodeEditor, and Monaco with it; each test settles it by hand.
vi.mock("../components/codeEditorLoader", () => ({
  whenCodeEditorLoaded: vi.fn<() => Promise<void>>(),
}));

function createRecording(): Recording {
  return {
    version: 4,
    id: "lesson",
    name: "Lesson",
    createdAt: 1_700_000_000_000,
    duration: 1000,
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "hello",
          position: { lineNumber: 1, column: 1 },
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
          viewState: null,
        },
      },
    ],
  };
}

/** An editor actor with a lesson loaded and ready to play. */
async function readyActor() {
  const actor = createActor(editorMachine, { input: { editorRef: { current: null } } }).start();
  actor.send({ type: "LOAD_RECORDING", recording: createRecording() });
  await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
  return actor;
}

/** Whether `promise` has settled once pending callbacks have run. */
async function hasSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

let loadCodeEditorChunk: () => void;

beforeEach(() => {
  vi.mocked(whenCodeEditorLoaded).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        loadCodeEditorChunk = resolve;
      }),
  );
});

afterEach(() => {
  vi.mocked(whenCodeEditorLoaded).mockReset();
});

describe("whenNarrationMayDownload", () => {
  it("waits while the code editor chunk loads and nothing plays", async () => {
    const actor = await readyActor();

    const gate = whenNarrationMayDownload(actor, new AbortController().signal);

    expect(await hasSettled(gate)).toBe(false);
    actor.stop();
  });

  it("opens once the code editor chunk has loaded", async () => {
    const actor = await readyActor();
    const gate = whenNarrationMayDownload(actor, new AbortController().signal);

    loadCodeEditorChunk();

    expect(await hasSettled(gate)).toBe(true);
    actor.stop();
  });

  it("opens when the viewer presses Play before the chunk has loaded", async () => {
    const actor = await readyActor();
    const gate = whenNarrationMayDownload(actor, new AbortController().signal);

    actor.send({ type: "PLAY" });

    expect(await hasSettled(gate)).toBe(true);
    actor.stop();
  });

  it("opens at once when the lesson is already playing", async () => {
    const actor = await readyActor();
    actor.send({ type: "PLAY" });

    const gate = whenNarrationMayDownload(actor, new AbortController().signal);

    expect(await hasSettled(gate)).toBe(true);
    expect(whenCodeEditorLoaded).not.toHaveBeenCalled();
    actor.stop();
  });

  it("stops waiting, and watching the editor, once the load is aborted", async () => {
    const actor = await readyActor();
    const subscribe = vi.spyOn(actor, "subscribe");
    const controller = new AbortController();
    const gate = whenNarrationMayDownload(actor, controller.signal);
    const [subscription] = subscribe.mock.results.map((result) => result.value as unknown);
    const unsubscribe = vi.spyOn(subscription as { unsubscribe: () => void }, "unsubscribe");

    controller.abort();

    expect(await hasSettled(gate)).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    actor.stop();
  });
});
