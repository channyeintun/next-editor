import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { StudioNarrationProvider } from "./narrationLanguage";
import type { NarratorVoicePanelProps, NarratorVoiceTask } from "./NarratorVoicePanel";
import type { SavedCustomVoice } from "./tts/customVoices";

const library = vi.hoisted(() => ({
  voices: [] as SavedCustomVoice[],
  synthesizePocket: vi.fn<() => Promise<Uint8Array>>(),
  saveVoice: vi.fn<(name: string, samples: Float32Array) => Promise<SavedCustomVoice>>(),
}));

vi.mock("./tts/pocketSynth", () => ({ synthesizePocketWav: library.synthesizePocket }));
vi.mock("./tts/modalVoxCpm2Synth", () => ({
  synthesizeModalVoxCpm2Wav: () => Promise.reject(new Error("unused")),
}));
vi.mock("./tts/customVoices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tts/customVoices")>()),
  listCustomVoices: () => Promise.resolve(library.voices),
  deleteCustomVoice: () => Promise.resolve(),
  prepareVoiceSample: () => Promise.resolve(new Float32Array(24_000 * 6)),
  saveCustomVoice: library.saveVoice,
}));

const { default: NarratorVoicePanel } = await import("./NarratorVoicePanel");

const VOICE_CHOICE_KEY = "next-editor:studio:voice-choice";

const narrator: SavedCustomVoice = {
  id: "voice-1",
  name: "Narrator",
  createdAtIso: "2026-01-01T00:00:00.000Z",
  sampleRate: 24_000,
  samples: new Float32Array(24_000 * 6),
  sampleSha256: "narrator-sha",
};

const onSelectedVoiceChange = vi.fn<NarratorVoicePanelProps["onSelectedVoiceChange"]>();
const onTaskChange = vi.fn<NarratorVoicePanelProps["onTaskChange"]>();
const onError = vi.fn<NarratorVoicePanelProps["onError"]>();

function renderPanel(provider: StudioNarrationProvider = "pocket") {
  return render(
    <NarratorVoicePanel
      provider={provider}
      disabled={false}
      onSelectedVoiceChange={onSelectedVoiceChange}
      onTaskChange={onTaskChange}
      onError={onError}
    />,
  );
}

function lastTask(): NarratorVoiceTask | undefined {
  return onTaskChange.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  library.voices = [narrator];
  localStorage.setItem(VOICE_CHOICE_KEY, narrator.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NarratorVoicePanel reporting", () => {
  it("reports the stored voice once the library has been read, never the empty pre-load list", async () => {
    renderPanel();
    expect(onSelectedVoiceChange).not.toHaveBeenCalled();

    await waitFor(() => expect(onSelectedVoiceChange).toHaveBeenCalledWith(narrator));
    expect(onSelectedVoiceChange).toHaveBeenCalledTimes(1);
  });

  it("reports the script default when no saved voice is chosen", async () => {
    localStorage.removeItem(VOICE_CHOICE_KEY);
    renderPanel();

    await waitFor(() => expect(onSelectedVoiceChange).toHaveBeenCalledWith(null));
  });

  it("reports a running voice task and its end", async () => {
    let finishPreview: (wav: Uint8Array) => void = () => {};
    library.synthesizePocket.mockReturnValue(
      new Promise((resolve) => {
        finishPreview = resolve;
      }),
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    renderPanel();
    expect(lastTask()).toEqual({ busy: null, recording: false });

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(lastTask()).toEqual({
        busy: 'Synthesizing a preview with "Narrator"…',
        recording: false,
      }),
    );

    finishPreview(new Uint8Array(44));
    await waitFor(() => expect(lastTask()).toEqual({ busy: null, recording: false }));
    expect(onError).not.toHaveBeenCalled();
  });

  it("sends a failed voice task to onError", async () => {
    library.synthesizePocket.mockRejectedValue(new Error("Pocket-TTS failed to load"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Pocket-TTS failed to load"));
    expect(lastTask()).toEqual({ busy: null, recording: false });
  });
});

describe("NarratorVoicePanel status region", () => {
  it("is mounted empty and announces a voice task", async () => {
    library.synthesizePocket.mockReturnValue(new Promise(() => {}));
    renderPanel();
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    const notice = await screen.findByText('Synthesizing a preview with "Narrator"…');
    expect(notice.closest('[role="status"]')).toBe(region);
  });

  it("stays mounted, alone, while AthanLab supplies the voice", async () => {
    renderPanel("athanlab");

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("combobox", { name: "Narrator voice" })).toBeNull();
    // The library still loads, so switching back finds the same selection.
    await waitFor(() => expect(onSelectedVoiceChange).toHaveBeenCalledWith(narrator));
  });
});

describe("NarratorVoicePanel voice focus", () => {
  it("names the voice delete button by its action and hides the glyph", async () => {
    renderPanel();

    const remove = await screen.findByRole("button", { name: "Delete voice" });
    expect(remove).toHaveTextContent("✕");
    expect(remove.querySelector('[aria-hidden="true"]')).toHaveTextContent("✕");
  });

  it("keeps focus on the voice select after deleting the selected voice", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();
    const remove = await screen.findByRole("button", { name: "Delete voice" });

    library.voices = [];
    remove.focus();
    fireEvent.click(remove);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Narrator voice" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Delete voice" })).toBeNull();
    expect(onSelectedVoiceChange).toHaveBeenLastCalledWith(null);
  });
});

/** A MediaRecorder double: start records, stop ends the take and fires onstop. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stop = vi.fn<() => void>(() => {
    this.state = "inactive";
    this.onstop?.();
  });

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }
}

describe("NarratorVoicePanel recording", () => {
  const track = { stop: vi.fn<() => void>() };
  let ownMediaDevices: PropertyDescriptor | undefined;

  beforeEach(() => {
    library.voices = [];
    localStorage.clear();
    library.saveVoice.mockResolvedValue(narrator);
    FakeMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    ownMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ownMediaDevices) Object.defineProperty(navigator, "mediaDevices", ownMediaDevices);
    else delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
  });

  it("toggles Record and Stop, and saves the take on Stop", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await screen.findByRole("button", { name: "Stop" });
    expect(
      screen.getByText(/Recording… speak naturally/).closest('[role="status"]'),
    ).not.toBeNull();
    expect(lastTask()).toEqual({ busy: null, recording: true });

    // What the library holds once the take is saved.
    library.voices = [narrator];
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    await waitFor(() =>
      expect(library.saveVoice).toHaveBeenCalledWith("My voice", expect.any(Float32Array)),
    );
    expect(await screen.findByRole("button", { name: "Record" })).toBeInTheDocument();
    await waitFor(() => expect(onSelectedVoiceChange).toHaveBeenLastCalledWith(narrator));
  });

  it("stops at the sample cap on its own and saves the take", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await screen.findByRole("button", { name: "Stop" });
    const autoStop = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 20_000)?.[0];
    if (typeof autoStop !== "function") throw new Error("No 20 s auto-stop scheduled");
    autoStop();

    expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    await waitFor(() =>
      expect(library.saveVoice).toHaveBeenCalledWith("My voice", expect.any(Float32Array)),
    );
    expect(await screen.findByRole("button", { name: "Record" })).toBeInTheDocument();
  });

  it("stops the microphone and discards the take when the console unmounts mid-take", async () => {
    const { unmount } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await screen.findByRole("button", { name: "Stop" });
    const recorder = FakeMediaRecorder.instances[0];
    unmount();

    expect(recorder?.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(library.saveVoice).not.toHaveBeenCalled();
  });
});
