import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fc from "fast-check";
import { createActor, fromCallback } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./editorMachine";
import { isRecordingClockPaused } from "./recordingClock";
import type {
  AudioPlaybackEmit,
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioRecordingEmit,
  AudioRecordingEvent,
  AudioRecordingInput,
} from "./audioActor";
import type {
  CameraRecordingEmit,
  CameraRecordingEvent,
  CameraRecordingInput,
} from "./cameraActor";
import type {
  ScreenRecordingEmit,
  ScreenRecordingEvent,
  ScreenRecordingInput,
} from "./screenActor";
import { fromTypedCallback } from "./fromTypedCallback";
import { selectNextEditorMetadata } from "../useNextEditor";

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

/** The Monaco surface createFrame reads during a take. */
class RecordingEditor {
  content = "const a = 1;";
  versionId = 1;
  readonly model = {
    uri: { toString: () => "file:///main.ts" },
    getVersionId: () => this.versionId,
  };

  getModel() {
    return this.model as unknown as monaco.editor.ITextModel;
  }

  getValue() {
    return this.content;
  }

  type(text: string) {
    this.content += text;
    this.versionId += 1;
  }

  getPosition() {
    return { lineNumber: 1, column: 1 };
  }

  getSelection() {
    return selection as monaco.Selection;
  }

  getScrollTop() {
    return 0;
  }

  getScrollLeft() {
    return 0;
  }

  saveViewState() {
    return null;
  }
}

function pinClocks() {
  const clock = { perf: 1_000, wall: 50_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.perf);
  vi.spyOn(Date, "now").mockImplementation(() => clock.wall);
  return {
    clock,
    advance(ms: number) {
      clock.perf += ms;
      clock.wall += ms;
    },
  };
}

const takeMachine = editorMachine.provide({
  actors: { mouseTracking: fromCallback(() => {}) },
});

function startTake(editor: RecordingEditor = new RecordingEditor()) {
  const actor = createActor(takeMachine, {
    input: {
      editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
    },
  }).start();
  actor.send({ type: "START_RECORDING" });
  expect(actor.getSnapshot().matches("recording")).toBe(true);
  return actor;
}

describe("pausing a take", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps what happens while paused at the pause, and skips the pause after it", () => {
    const { advance } = pinClocks();
    const editor = new RecordingEditor();
    const actor = startTake(editor);
    const session = () => actor.getSnapshot().context.session!;

    advance(2_000);
    actor.send({ type: "PAUSE_RECORDING" });
    expect(selectNextEditorMetadata(actor.getSnapshot()).isRecordingPaused).toBe(true);

    advance(5_000);
    editor.type("!");
    actor.send({ type: "CAPTURE_FRAME" });
    actor.send({ type: "WHITEBOARD_EVENT", event: { timestamp: 0, isOpen: true } });
    expect(session().frames.at(-1)?.timestamp).toBe(2_000);
    expect(session().whiteboardEvents.at(-1)?.timestamp).toBe(2_000);

    actor.send({ type: "RESUME_RECORDING" });
    expect(selectNextEditorMetadata(actor.getSnapshot()).isRecordingPaused).toBe(false);
    advance(1_000);
    editor.type("?");
    actor.send({ type: "CAPTURE_FRAME" });
    expect(session().frames.at(-1)?.timestamp).toBe(3_000);
    actor.stop();
  });

  it("follows the pointer while paused and records where it ended up on resume", () => {
    const { advance } = pinClocks();
    const actor = startTake();
    const cursorEvents = () => actor.getSnapshot().context.session!.cursorEvents;

    advance(1_000);
    actor.send({ type: "PAUSE_RECORDING" });
    const samplesAtPause = cursorEvents().length;

    for (const x of [40, 80, 120]) {
      advance(100);
      actor.send({
        type: "CAPTURE_FRAME",
        isMouseMovement: true,
        mousePosition: { x, y: 10, visible: true },
      });
    }
    expect(cursorEvents()).toHaveLength(samplesAtPause);

    actor.send({ type: "RESUME_RECORDING" });
    expect(cursorEvents().at(-1)).toEqual({ timestamp: 1_000, x: 120, y: 10, visible: true });
    actor.stop();
  });

  it("ends a take stopped while paused where it paused", async () => {
    const { advance } = pinClocks();
    const actor = startTake();

    advance(2_500);
    actor.send({ type: "PAUSE_RECORDING" });
    advance(60_000);
    actor.send({ type: "STOP_RECORDING" });

    await vi.waitFor(() => expect(actor.getSnapshot().context.recording).not.toBeNull());
    expect(actor.getSnapshot().context.recording?.duration).toBe(2_500);
    actor.stop();
  });

  it("ignores a second pause, and a resume while running", () => {
    const { advance } = pinClocks();
    const actor = startTake();
    const clock = () => actor.getSnapshot().context.session!.clock;

    const running = clock();
    actor.send({ type: "RESUME_RECORDING" });
    expect(clock()).toBe(running);

    advance(500);
    actor.send({ type: "PAUSE_RECORDING" });
    const paused = clock();
    advance(500);
    actor.send({ type: "PAUSE_RECORDING" });
    expect(clock()).toBe(paused);
    expect(paused.pausedAt).toEqual({ perf: 1_500, wall: 50_500 });
    actor.stop();
  });

  // The `paused` substate and the clock's pausedAt say the same thing in two places. The
  // transitions that move one move the other, whatever the author presses and when. A new
  // event that changes the take's clock belongs in the list below, or this check cannot see it.
  it("keeps the paused substate and the paused clock in step", () => {
    const { advance } = pinClocks();
    const step = fc.oneof(
      fc.constantFrom(
        { type: "PAUSE_RECORDING" } as const,
        { type: "RESUME_RECORDING" } as const,
        { type: "RETAKE_RECORDING" } as const,
        { type: "ADD_CHAPTER_MARKER" } as const,
        { type: "CAPTURE_FRAME" } as const,
      ),
      fc.integer({ min: 0, max: 2_000 }),
    );

    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        const actor = startTake();
        try {
          for (const item of steps) {
            if (typeof item === "number") advance(item);
            else actor.send(item);
            const snapshot = actor.getSnapshot();
            expect(snapshot.matches({ recording: "paused" })).toBe(
              isRecordingClockPaused(snapshot.context.session!.clock),
            );
          }
        } finally {
          actor.stop();
        }
      }),
    );
  });

  it("takes the pause out of the preview's wall-clock stamps", () => {
    const { advance } = pinClocks();
    const actor = startTake();
    const batches = () => actor.getSnapshot().context.session!.previewPatchBatches;
    const batch = (timestamp: number) => ({
      version: 2,
      time: 0,
      source: "runtime-preview" as const,
      documentId: "doc",
      events: [{ type: 3, data: {}, timestamp }],
    });

    advance(1_000); // wall 51_000
    actor.send({ type: "PREVIEW_PATCH_BATCH", batch: batch(51_000) });
    actor.send({ type: "PAUSE_RECORDING" });
    advance(4_000); // wall 55_000
    // Stamped inside the pause: it happened at the pause, as far as the take is concerned.
    actor.send({ type: "PREVIEW_PATCH_BATCH", batch: batch(53_000) });
    actor.send({ type: "RESUME_RECORDING" });
    advance(500); // wall 55_500
    actor.send({ type: "PREVIEW_PATCH_BATCH", batch: batch(55_500) });

    expect(batches().map((entry) => [entry.time, entry.events?.[0].timestamp])).toEqual([
      [1_000, 51_000],
      [1_000, 51_000],
      [1_500, 51_500],
    ]);
    actor.stop();
  });
});

describe("pausing a take's recorders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pauses and resumes the microphone with the take", () => {
    pinClocks();
    const received: AudioRecordingEvent["type"][] = [];
    const machine = takeMachine.provide({
      actors: {
        audioRecording: fromTypedCallback<
          AudioRecordingEvent,
          AudioRecordingInput,
          AudioRecordingEmit
        >(({ receive, sendBack }) => {
          receive((event) => {
            received.push(event.type);
            if (event.type !== "START") return;
            sendBack({
              type: "AUDIO_RECORDING_STARTED",
              mediaRecorder: {} as MediaRecorder,
              mimeType: "audio/webm",
              startedAtMs: Date.now(),
              startedAtPerf: performance.now(),
            });
          });
        }),
      },
    });
    const actor = createActor(machine, {
      input: { editorRef: { current: null }, enableAudioRecording: true },
    }).start();

    actor.send({ type: "START_RECORDING" });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });

    expect(received).toEqual(["START", "PAUSE", "RESUME"]);
    actor.stop();
  });

  it("holds a selected narration file in place while the take is paused", () => {
    pinClocks();
    const received: AudioPlaybackEvent["type"][] = [];
    const machine = takeMachine.provide({
      actors: {
        audioPlayback: fromTypedCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
          ({ receive }) => {
            receive((event) => received.push(event.type));
          },
        ),
      },
    });
    const actor = createActor(machine, { input: { editorRef: { current: null } } }).start();

    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["narration"], { type: "audio/webm" }),
    });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });

    expect(received).toEqual(["PLAY", "PAUSE", "PLAY"]);
    actor.stop();
  });

  // Fakes that only log what the machine sends them.
  const cameraRecorder = (received: CameraRecordingEvent["type"][]) =>
    fromTypedCallback<CameraRecordingEvent, CameraRecordingInput, CameraRecordingEmit>(
      ({ receive }) => {
        receive((event) => received.push(event.type));
      },
    );
  const screenRecorder = (received: ScreenRecordingEvent["type"][]) =>
    fromTypedCallback<ScreenRecordingEvent, ScreenRecordingInput, ScreenRecordingEmit>(
      ({ receive }) => {
        receive((event) => received.push(event.type));
      },
    );
  const displayStream = () => ({ getTracks: () => [] }) as unknown as MediaStream;

  it("pauses and resumes the camera with the take", () => {
    pinClocks();
    const received: CameraRecordingEvent["type"][] = [];
    const machine = takeMachine.provide({
      actors: { cameraRecording: cameraRecorder(received) },
    });
    const actor = createActor(machine, { input: { editorRef: { current: null } } }).start();

    actor.send({ type: "START_RECORDING", enableCamera: true });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });

    expect(received).toEqual(["START", "PAUSE", "RESUME"]);
    actor.stop();
  });

  it("pauses and resumes the screen recording with the take", () => {
    pinClocks();
    const received: ScreenRecordingEvent["type"][] = [];
    const machine = takeMachine.provide({
      actors: { screenRecording: screenRecorder(received) },
    });
    const actor = createActor(machine, { input: { editorRef: { current: null } } }).start();

    actor.send({ type: "START_RECORDING", screenStream: displayStream() });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });

    expect(received).toEqual(["START", "PAUSE", "RESUME"]);
    actor.stop();
  });

  it("holds the camera and the screen recording on a retake, and stops both with the take", () => {
    const { advance } = pinClocks();
    const camera: CameraRecordingEvent["type"][] = [];
    const screen: ScreenRecordingEvent["type"][] = [];
    const machine = takeMachine.provide({
      actors: { cameraRecording: cameraRecorder(camera), screenRecording: screenRecorder(screen) },
    });
    const actor = createActor(machine, { input: { editorRef: { current: null } } }).start();

    actor.send({ type: "START_RECORDING", enableCamera: true, screenStream: displayStream() });
    advance(1_000);
    actor.send({ type: "RETAKE_RECORDING" });
    expect(selectNextEditorMetadata(actor.getSnapshot()).isRecordingPaused).toBe(true);
    actor.send({ type: "STOP_RECORDING" });

    // The camera drains in stoppingRecording; the screen recorder is stopped on leaving recording.
    expect(actor.getSnapshot().value).toBe("stoppingRecording");
    expect(camera).toEqual(["START", "PAUSE", "STOP"]);
    expect(screen).toEqual(["START", "PAUSE", "STOP"]);
    actor.stop();
  });
});
