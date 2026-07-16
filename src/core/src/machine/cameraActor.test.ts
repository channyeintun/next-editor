import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import { editorMachine } from "./editorMachine";

class FakeCameraTrack {
  stopped = false;

  stop() {
    this.stopped = true;
  }
}

class FakeCameraStream {
  private readonly track: FakeCameraTrack;

  constructor(track: FakeCameraTrack) {
    this.track = track;
  }

  getTracks() {
    return [this.track];
  }
}

class FakeCameraMediaRecorder {
  static instances: FakeCameraMediaRecorder[] = [];

  static isTypeSupported() {
    return true;
  }

  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    FakeCameraMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
    this.onstart?.();
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.onstop?.();
  }
}

describe("camera recorder integration", () => {
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let actors: Array<ReturnType<typeof createActor>> = [];
  let track: FakeCameraTrack;

  beforeEach(() => {
    track = new FakeCameraTrack();
    FakeCameraMediaRecorder.instances = [];
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeCameraMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve(new FakeCameraStream(track) as unknown as MediaStream),
      },
    });
  });

  afterEach(() => {
    for (const actor of actors) actor.stop();
    actors = [];
    if (originalMediaRecorder) {
      Object.defineProperty(globalThis, "MediaRecorder", originalMediaRecorder);
    } else {
      delete (globalThis as Record<string, unknown>).MediaRecorder;
    }
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    }
  });

  it("reports a MediaRecorder runtime error and retires the camera child", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, enableCameraRecording: true },
    }).start();
    actors.push(actor);

    actor.send({ type: "START_RECORDING" });
    await waitFor(
      actor,
      (snapshot) => snapshot.context.camera.mimeType === "video/webm;codecs=vp9",
    );
    expect(actor.getSnapshot().children.cameraRecorder).toBeDefined();

    const errorEvent = Object.assign(new Event("error"), { error: new Error("camera failed") });
    FakeCameraMediaRecorder.instances[0]!.onerror?.(errorEvent);

    expect(actor.getSnapshot().value).toBe("recording");
    expect(actor.getSnapshot().children.cameraRecorder).toBeUndefined();
    expect(actor.getSnapshot().context.camera.isRecording).toBe(false);
    expect(track.stopped).toBe(true);
  });
});
