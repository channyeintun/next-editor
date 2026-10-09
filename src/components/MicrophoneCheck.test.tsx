import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import MicrophoneCheck, { RecordingMicrophoneLevel } from "./MicrophoneCheck";
import { listAudioInputs } from "../hooks/useAudioInputDevices";
import { recordingSettingsStore } from "../stores/recordingSettingsStore";

/** The running take's microphone, for RecordingMicrophoneLevel. */
const take = vi.hoisted(() => ({ stream: null as MediaStream | null }));
vi.mock("../hooks/useNextEditorContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useNextEditorContext")>()),
  useRecordingMicrophoneStream: () => take.stream,
}));

const DEFAULTS = { autoGainControl: true, echoCancellation: true, noiseSuppression: true };

class FakeTrack {
  stopped = false;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  stop() {
    this.stopped = true;
  }
}

function fakeStream(label: string) {
  const track = new FakeTrack(label);
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
}

/** An analyser that hears a steady tone at `amplitude`. */
function stubAudio(amplitude: number) {
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        getFloatTimeDomainData(samples: Float32Array) {
          samples.fill(amplitude);
        },
      };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback((now += 100)), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
}

function device(deviceId: string, label: string, kind: MediaDeviceKind = "audioinput") {
  return { deviceId, label, kind, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

describe("listAudioInputs", () => {
  it("lists real microphones, not Chrome's aliases or other devices", () => {
    expect(
      listAudioInputs([
        device("default", "Default - Built-in"),
        device("communications", "Communications - Built-in"),
        device("built-in", "Built-in Microphone"),
        device("usb", "USB Mic"),
        device("camera", "FaceTime Camera", "videoinput"),
        device("speakers", "Speakers", "audiooutput"),
      ]),
    ).toEqual([
      { deviceId: "built-in", label: "Built-in Microphone" },
      { deviceId: "usb", label: "USB Mic" },
    ]);
  });

  it("numbers microphones whose names are not shown yet", () => {
    expect(listAudioInputs([device("a", ""), device("b", "")])).toEqual([
      { deviceId: "a", label: "Microphone 1" },
      { deviceId: "b", label: "Microphone 2" },
    ]);
  });
});

describe("MicrophoneCheck", () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let requests: MediaStreamConstraints[];
  let tracks: FakeTrack[];

  beforeEach(() => {
    recordingSettingsStore.trigger.setMicrophoneDeviceId({ deviceId: null });
    requests = [];
    tracks = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: (constraints: MediaStreamConstraints) => {
          requests.push(constraints);
          const { track, stream } = fakeStream(`mic ${requests.length}`);
          tracks.push(track);
          return Promise.resolve(stream);
        },
        enumerateDevices: () =>
          Promise.resolve([device("built-in", "Built-in Microphone"), device("usb", "USB Mic")]),
        addEventListener() {},
        removeEventListener() {},
      },
    });
  });

  afterEach(() => {
    // Unmount first: the meter needs the stubbed audio until it has stopped.
    cleanup();
    vi.unstubAllGlobals();
    if (originalMediaDevices)
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });

  it("listens to the microphone takes will use, and shows how it sounds", async () => {
    stubAudio(0.3);
    render(<MicrophoneCheck />);

    fireEvent.click(screen.getByTitle("Check the microphone"));

    expect(await screen.findByText("Sounds good.")).toBeTruthy();
    expect(requests).toEqual([{ audio: DEFAULTS }]);
    expect(screen.getByRole("option", { name: "USB Mic" })).toBeTruthy();
  });

  it("switches to a picked microphone, remembers it, and lets the old one go", async () => {
    stubAudio(0.3);
    render(<MicrophoneCheck />);
    fireEvent.click(screen.getByTitle("Check the microphone"));
    await screen.findByRole("option", { name: "USB Mic" });

    fireEvent.change(screen.getByLabelText("Microphone to record from"), {
      target: { value: "usb" },
    });

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({ audio: { ...DEFAULTS, deviceId: { exact: "usb" } } });
    expect(recordingSettingsStore.getSnapshot().context.microphoneDeviceId).toBe("usb");
    expect(tracks[0].stopped).toBe(true);
  });

  it("warns about silence, and releases the microphone when closed", async () => {
    stubAudio(0);
    render(<MicrophoneCheck />);
    fireEvent.click(screen.getByTitle("Check the microphone"));

    expect(await screen.findByText(/No sound yet/)).toBeTruthy();

    screen.getByRole("combobox", { name: "Microphone to record from" }).focus();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tracks.every((track) => track.stopped)).toBe(true);
    // Focus was in the check it closed: it goes back to the button that opened it.
    expect(screen.getByRole("button", { name: "Check the microphone" })).toHaveFocus();
  });

  it("returns focus from its close button, and leaves focus elsewhere alone", async () => {
    stubAudio(0.3);
    render(
      <>
        <MicrophoneCheck />
        <textarea aria-label="Code" />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Check the microphone" });
    fireEvent.click(trigger);
    await screen.findByText("Sounds good.");

    const close = screen.getByRole("button", { name: "Close the microphone check" });
    close.focus();
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    await screen.findByText("Sounds good.");
    const code = screen.getByRole("textbox", { name: "Code" });
    code.focus();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(code).toHaveFocus();
  });

  it("explains a blocked microphone", async () => {
    stubAudio(0.3);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
        enumerateDevices: () => Promise.resolve([]),
      },
    });
    render(<MicrophoneCheck />);
    fireEvent.click(screen.getByTitle("Check the microphone"));
    const region = screen.getByRole("dialog").querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();

    expect(await screen.findByText(/Microphone access is blocked/)).toBeTruthy();
    // Announced: the error replaces the verdict in the live region that was already there.
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent("Microphone access is blocked");
  });
});

describe("RecordingMicrophoneLevel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    take.stream = null;
  });

  it("announces a take that hears nothing, at every width", async () => {
    stubAudio(0);
    take.stream = fakeStream("Built-in Microphone").stream as unknown as MediaStream;
    render(<RecordingMicrophoneLevel />);

    // The status is there, empty, before the warning arrives.
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    await waitFor(() =>
      expect(status).toHaveTextContent(
        "No sound from the microphone yet. Check that it is on and not muted.",
      ),
    );
    // The short visible note (wide screens only) is not read a second time.
    expect(screen.getByText("No sound yet")).toHaveAttribute("aria-hidden", "true");
  });
});
