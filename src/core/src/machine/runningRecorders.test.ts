import { describe, expect, it } from "vite-plus/test";
import type { AudioPlaybackEvent } from "./audioActor";
import type { RecorderControlEvent } from "./recorderControl";
import {
  getRunningRecorders,
  pauseRecordingMedia,
  PAUSE_RECORDER_SENDS,
  resumeRecordingMedia,
  sendToRunningRecorders,
  stopRecordingMedia,
  stopScreenRecording,
  type RecorderSendEnqueue,
} from "./runningRecorders";
import { createInitialContext, type EditorMachineContext } from "./types";

type Sent = { actor: string; event: RecorderControlEvent | AudioPlaybackEvent };

function recordingEnqueue() {
  const sent: Sent[] = [];
  const enqueue: RecorderSendEnqueue = {
    sendTo: (actor: string, event: RecorderControlEvent | AudioPlaybackEvent) => {
      sent.push({ actor, event });
    },
  };
  return { sent, enqueue };
}

const sentTo = (sent: readonly Sent[]) => sent.map(({ actor, event }) => `${actor}:${event.type}`);

interface Setup {
  audio: "none" | "microphone" | "external";
  camera: boolean;
  screen: boolean;
}

/** Every mix of running recorders a take can have: one narration source at most. */
const SETUPS: Setup[] = (["none", "microphone", "external"] as const).flatMap((audio) =>
  [false, true].flatMap((camera) => [false, true].map((screen) => ({ audio, camera, screen }))),
);

function contextFor({ audio, camera, screen }: Setup): EditorMachineContext {
  const context = createInitialContext({ editorRef: { current: null } });
  return {
    ...context,
    audio: {
      ...context.audio,
      isRecording: audio !== "none",
      source: audio === "none" ? null : audio,
    },
    enableCameraRecording: camera,
    camera: { ...context.camera, isRecording: camera },
    screen: { actorId: screen ? "screen-1" : null, isRecording: screen },
  };
}

/** The sends expected for `setup`, in the fan-out's order. */
function expectedSends(
  setup: Setup,
  events: { microphone?: string; externalAudio?: string; camera?: string; screen?: string },
): string[] {
  return [
    setup.audio === "microphone" && events.microphone && `audioRecorder:${events.microphone}`,
    setup.audio === "external" &&
      events.externalAudio &&
      `recordingAudioPlayer:${events.externalAudio}`,
    setup.camera && events.camera && `cameraRecorder:${events.camera}`,
    setup.screen && events.screen && `screen-1:${events.screen}`,
  ].filter((send): send is string => typeof send === "string");
}

const label = ({ audio, camera, screen }: Setup) =>
  `audio ${audio}, camera ${camera ? "on" : "off"}, screen ${screen ? "on" : "off"}`;

describe("getRunningRecorders", () => {
  it("counts a narration source only while it is recording", () => {
    const context = contextFor({ audio: "microphone", camera: false, screen: false });
    const stopped = { ...context, audio: { ...context.audio, isRecording: false } };

    expect(getRunningRecorders(context).microphone).toBe(true);
    expect(getRunningRecorders(stopped)).toEqual({
      microphone: false,
      externalAudio: false,
      camera: false,
      screenActorId: null,
    });
  });

  it("counts the camera only while camera recording is enabled for the take", () => {
    const context = contextFor({ audio: "none", camera: true, screen: false });

    expect(getRunningRecorders(context).camera).toBe(true);
    expect(getRunningRecorders({ ...context, enableCameraRecording: false }).camera).toBe(false);
  });
});

describe("the recorder actions", () => {
  it.each(SETUPS.map((setup) => [label(setup), setup] as const))(
    "send to exactly the running recorders, in order (%s)",
    (_, setup) => {
      const context = contextFor(setup);
      const event = { type: "PAUSE_RECORDING" } as const;
      const run = (body: typeof pauseRecordingMedia) => {
        const { sent, enqueue } = recordingEnqueue();
        body({ context, event, enqueue });
        return sentTo(sent);
      };

      expect(run(pauseRecordingMedia)).toEqual(
        expectedSends(setup, {
          microphone: "PAUSE",
          externalAudio: "PAUSE",
          camera: "PAUSE",
          screen: "PAUSE",
        }),
      );
      expect(run(resumeRecordingMedia)).toEqual(
        expectedSends(setup, {
          microphone: "RESUME",
          externalAudio: "PLAY",
          camera: "RESUME",
          screen: "RESUME",
        }),
      );
      // The narration file and the screen are not asked for files when the take stops.
      expect(run(stopRecordingMedia)).toEqual(
        expectedSends(setup, { microphone: "STOP", camera: "STOP" }),
      );
      expect(run(stopScreenRecording)).toEqual(expectedSends(setup, { screen: "STOP" }));
    },
  );
});

describe("sendToRunningRecorders", () => {
  it("sends the narration player's events in list order, between the microphone's and the camera's", () => {
    const { sent, enqueue } = recordingEnqueue();

    // A retake's hold: the pause sends, with the narration file also rewound.
    sendToRunningRecorders(
      { microphone: true, externalAudio: true, camera: true, screenActorId: "screen-1" },
      enqueue,
      {
        ...PAUSE_RECORDER_SENDS,
        externalAudio: [{ type: "PAUSE" }, { type: "SEEK", timeMs: 1_000 }],
      },
    );

    expect(sent).toEqual([
      { actor: "audioRecorder", event: { type: "PAUSE" } },
      { actor: "recordingAudioPlayer", event: { type: "PAUSE" } },
      { actor: "recordingAudioPlayer", event: { type: "SEEK", timeMs: 1_000 } },
      { actor: "cameraRecorder", event: { type: "PAUSE" } },
      { actor: "screen-1", event: { type: "PAUSE" } },
    ]);
  });

  it("sends nothing to a recorder that is not running", () => {
    const { sent, enqueue } = recordingEnqueue();

    sendToRunningRecorders(
      { microphone: false, externalAudio: false, camera: false, screenActorId: null },
      enqueue,
      PAUSE_RECORDER_SENDS,
    );

    expect(sent).toEqual([]);
  });
});
