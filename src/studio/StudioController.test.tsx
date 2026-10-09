import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AthanLabPanelProps } from "./AthanLabPanel";
import type { runStudioRender } from "./runStudioRender";
import type { SavedCustomVoice } from "./tts/customVoices";
import type { VoiceProfile } from "./tts/profiles";

const studio = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  runRender: vi.fn<typeof runStudioRender>(),
  voices: [] as SavedCustomVoice[],
  synthesizePocket: vi.fn<() => Promise<Uint8Array>>(),
  /** When set, the voice library read waits on this instead of resolving `voices`. */
  voicesLoad: null as Promise<SavedCustomVoice[]> | null,
  capabilities: { athanlab: false, burmeseVoxCpm2: false },
  athanLabPanel: null as AthanLabPanelProps | null,
  /** The voice the last plan build synthesized with. */
  builtVoiceProfile: undefined as VoiceProfile | undefined,
}));

vi.mock("react-router", () => ({
  useSearchParams: () => [studio.searchParams, () => {}],
}));

vi.mock("@next-editor/infra", () => ({
  invalidateAthanLabAccount: () => Promise.resolve(),
  UploadLessonModal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close draft upload
    </button>
  ),
  useAuth: () => ({ user: null, isLoading: false }),
  useStudioCapabilities: () => ({ capabilities: studio.capabilities, isLoading: false }),
}));

vi.mock("./AthanLabPanel", () => ({
  default: (props: AthanLabPanelProps) => {
    studio.athanLabPanel = props;
    return null;
  },
}));
vi.mock("../contexts/NextEditorActorContext", () => ({
  NextEditorActorContext: { useActorRef: () => ({}) },
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ editorRef: { current: null } }),
}));
vi.mock("../contexts/RuntimePanelStoreContext", () => ({
  useRuntimePanelStore: () => ({ store: {} }),
}));
vi.mock("../contexts/SlidesStoreContext", () => ({ useSlidesStore: () => ({ store: {} }) }));
vi.mock("../contexts/WhiteboardStoreContext", () => ({
  useWhiteboardStore: () => ({ store: {} }),
}));
vi.mock("../hooks/useWorkspace", () => ({ useWorkspaceActions: () => ({}) }));
vi.mock("../hooks/useWebContainerRuntime", () => ({
  useWebContainerRuntimeActions: () => ({}),
  useWebContainerRuntimeMetadata: () => ({}),
  useWebContainerRuntimeSnapshotGetter: () => () => null,
}));
vi.mock("../contexts/PreviewPanelContext", () => ({
  usePreviewPanel: () => ({ openPreview: () => {}, closePreview: () => {} }),
}));
vi.mock("../contexts/PreviewAdapterHandleContext", () => ({
  usePreviewAdapterHandle: () => ({
    snapshotGetter: { current: null },
    previewCommandExecutor: { current: null },
    previewScreenshotCapturer: { current: null },
  }),
}));
vi.mock("../components/tour/productTour", () => ({ markTourSeen: () => {} }));
vi.mock("../hooks/useRecordingSettings", () => ({
  useRecordingSettings: () => ({ screenRecordingEnabled: false }),
  useRecordingSettingsTrigger: () => ({ setScreenRecordingEnabled: () => {} }),
}));
vi.mock("../utils/displayCapture", () => ({
  acquireDisplayStream: () => Promise.reject(new Error("unsupported")),
  isScreenCaptureSupported: () => false,
}));
// The plan carries what the controller reads back: the slug and title it
// records and the runtime its mode defaults from.
vi.mock("./inPageDirector", () => ({
  buildPlanFromScript: (
    script: { lesson: unknown; runtime: unknown },
    options: { voiceProfile?: VoiceProfile },
  ) => {
    studio.builtVoiceProfile = options.voiceProfile;
    return Promise.resolve({
      plan: { lesson: script.lesson, runtime: script.runtime },
      narration: { blob: new Blob(), bytes: new Uint8Array(), audioSha256: "0".repeat(64) },
      warnings: [],
    });
  },
}));
vi.mock("./runStudioRender", () => ({ runStudioRender: studio.runRender }));
vi.mock("./tts/pocketSynth", () => ({ synthesizePocketWav: studio.synthesizePocket }));
vi.mock("./tts/modalVoxCpm2Synth", () => ({
  synthesizeModalVoxCpm2Wav: () => Promise.reject(new Error("unused")),
}));
vi.mock("./tts/customVoices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tts/customVoices")>()),
  listCustomVoices: () => studio.voicesLoad ?? Promise.resolve(studio.voices),
  deleteCustomVoice: () => Promise.resolve(),
}));
// One English script that can start with the default English provider, one
// Burmese script that cannot, and one imported-style script that no longer
// parses against the schema.
vi.mock("./plans", () => ({
  DEFAULT_STUDIO_PLAN_SLUG: "english-script",
  STUDIO_SOURCES: {
    "english-script": {
      kind: "script",
      load: () => ({
        lesson: { slug: "english-script", title: "English script", locale: "en-US" },
        runtime: { kind: "none" },
        scenes: [],
      }),
    },
    "burmese-script": {
      kind: "script",
      load: () => ({
        lesson: { slug: "burmese-script", title: "Burmese script", locale: "my-MM" },
        runtime: { kind: "none" },
        scenes: [],
      }),
    },
    "broken-script": {
      kind: "script",
      load: () => {
        throw new Error('Unrecognized key: "legacyField"');
      },
    },
  },
  parseLessonScriptYaml: () => {
    throw new Error("unused");
  },
}));

const { default: StudioController } = await import("./StudioController");

const narrator: SavedCustomVoice = {
  id: "voice-1",
  name: "Narrator",
  createdAtIso: "2026-01-01T00:00:00.000Z",
  sampleRate: 24_000,
  samples: new Float32Array(24_000 * 6),
  sampleSha256: "narrator-sha",
};

function renderController(Controller = StudioController) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Controller />
    </QueryClientProvider>,
  );
}

let freshInstances = 0;

/**
 * A fresh StudioController module for an autostart test: the unattended render
 * is one-shot per module load. The query string makes a separate instance of
 * this module only — React and React Query stay the shared ones.
 */
async function freshStudioController(): Promise<typeof StudioController> {
  freshInstances += 1;
  const module = (await import(
    /* @vite-ignore */ `./StudioController.tsx?instance=${freshInstances}`
  )) as typeof import("./StudioController");
  return module.default;
}

/** Report an automation-controlled browser (navigator.webdriver) until restored. */
function stubWebdriver(): () => void {
  const own = Object.getOwnPropertyDescriptor(navigator, "webdriver");
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => true });
  return () => {
    if (own) Object.defineProperty(navigator, "webdriver", own);
    else delete (navigator as { webdriver?: boolean }).webdriver;
  };
}

/** The header badge: the status region whose text starts with its sr-only label. */
function renderStatus(): HTMLElement {
  const region = screen
    .getAllByRole("status")
    .find((element) => element.textContent?.startsWith("Render status:"));
  if (!region) throw new Error("No render status region");
  return region;
}

function startButton(): HTMLElement {
  return screen.getByRole("button", { name: /^(start render|render again)$/i });
}

describe("StudioController status messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    studio.searchParams = new URLSearchParams();
    studio.voices = [];
  });

  it("announces render progress and its failure, also while the console is collapsed", async () => {
    let failRender: (error: Error) => void = () => {};
    studio.runRender.mockImplementation((_plan, _mode, deps) => {
      deps.onPhase?.("perform");
      return new Promise((_resolve, reject) => {
        failRender = reject;
      });
    });
    renderController();
    expect(renderStatus()).toHaveTextContent("Render status: ready");

    fireEvent.click(startButton());
    await waitFor(() => expect(renderStatus()).toHaveTextContent("Render status: perform"));

    fireEvent.click(screen.getByRole("button", { name: "Collapse studio render panel" }));
    failRender(new Error("The live preview command bridge is not mounted"));

    await waitFor(() => expect(renderStatus()).toHaveTextContent("Render status: failed"));
    fireEvent.click(screen.getByRole("button", { name: "Expand studio render panel" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The live preview command bridge is not mounted",
    );
  });

  it("describes the disabled Start button with its reason, without announcing the reason", () => {
    studio.searchParams = new URLSearchParams("plan=burmese-script");
    renderController();

    const start = startButton();
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription(/needs Burmese narration/);
    const reason = screen.getByText(/needs Burmese narration/);
    expect(reason.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });

  it("keeps the console up for a script that no longer parses, and reports why on Start", async () => {
    studio.searchParams = new URLSearchParams("plan=broken-script");
    renderController();

    expect(screen.getByText(/^runtime/).textContent).toMatch(/^runtime \? · run #/);
    const start = startButton();
    expect(start).toBeEnabled();

    fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent('Unrecognized key: "legacyField"');
    expect(studio.runRender).not.toHaveBeenCalled();
  });
});

describe("StudioController preferences", () => {
  let ownLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    studio.searchParams = new URLSearchParams();
    studio.voices = [];
    ownLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
  });

  afterEach(() => {
    if (ownLocalStorage) Object.defineProperty(window, "localStorage", ownLocalStorage);
    else delete (window as { localStorage?: Storage }).localStorage;
  });

  it("falls back to the default provider and voice where site data is blocked", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    renderController();

    expect(screen.getByRole("combobox", { name: "Narration language and provider" })).toHaveValue(
      "pocket",
    );
    expect(screen.getByRole("combobox", { name: "Narrator voice" })).toHaveValue("default");
  });
});

describe("StudioController unattended render", () => {
  let restoreWebdriver: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    studio.voices = [];
    restoreWebdriver = stubWebdriver();
  });

  afterEach(() => {
    restoreWebdriver();
    studio.voicesLoad = null;
    studio.capabilities = { athanlab: false, burmeseVoxCpm2: false };
    studio.athanLabPanel = null;
  });

  /** Long enough for every effect and resolved promise of the mount to settle. */
  const settle = () => act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));

  it("waits for the saved voices, then renders with the stored one", async () => {
    let resolveVoices: (voices: SavedCustomVoice[]) => void = () => {};
    studio.voicesLoad = new Promise((resolve) => {
      resolveVoices = resolve;
    });
    localStorage.setItem("next-editor:studio:voice-choice", narrator.id);
    studio.runRender.mockReturnValue(new Promise(() => {}));
    studio.searchParams = new URLSearchParams("autostart=1");
    renderController(await freshStudioController());

    await settle();
    expect(studio.runRender).not.toHaveBeenCalled();

    resolveVoices([narrator]);
    await waitFor(() => expect(studio.runRender).toHaveBeenCalledTimes(1));
    expect(studio.builtVoiceProfile).toMatchObject({ customVoiceId: narrator.id });
  });

  it("renders in English when the stored VoxCPM2 provider is not enabled, as the console falls back", async () => {
    localStorage.setItem("next-editor:studio:narration-provider", "voxcpm2");
    studio.runRender.mockReturnValue(new Promise(() => {}));
    studio.searchParams = new URLSearchParams("autostart=1");
    renderController(await freshStudioController());

    await waitFor(() => expect(studio.runRender).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("combobox", { name: "Narration language and provider" })).toHaveValue(
      "pocket",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits for a ready AthanLab panel before an AthanLab render", async () => {
    studio.capabilities = { athanlab: true, burmeseVoxCpm2: false };
    localStorage.setItem("next-editor:studio:narration-provider", "athanlab");
    studio.runRender.mockReturnValue(new Promise(() => {}));
    studio.searchParams = new URLSearchParams("plan=burmese-script&autostart=1");
    renderController(await freshStudioController());

    await settle();
    const panel = studio.athanLabPanel;
    if (!panel) throw new Error("AthanLabPanel not rendered");
    act(() => panel.onReadyChange(false, "Checking your AthanLab key…"));
    await settle();
    expect(studio.runRender).not.toHaveBeenCalled();

    act(() => {
      panel.onVoiceChange("voice-a", "Voice A");
      panel.onReadyChange(true, null);
    });
    await waitFor(() => expect(studio.runRender).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses a script the provider cannot narrate with the Start guard's own reason", async () => {
    studio.searchParams = new URLSearchParams("plan=burmese-script&autostart=1");
    renderController(await freshStudioController());

    const alert = await screen.findByRole("alert");
    const guardReason = screen.getByText(/needs Burmese narration/, {
      selector: "#studio-start-blocked-reason",
    });
    expect(alert.textContent).toBe(guardReason.textContent);
    expect(studio.runRender).not.toHaveBeenCalled();
  });
});

// The library itself is NarratorVoicePanel's (NarratorVoicePanel.test.tsx);
// these pin what the console does with what the panel reports.
describe("StudioController narrator voice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    studio.searchParams = new URLSearchParams();
    studio.voices = [narrator];
    localStorage.setItem("next-editor:studio:voice-choice", narrator.id);
  });

  it("renders with the voice the panel reports", async () => {
    studio.runRender.mockReturnValue(new Promise(() => {}));
    renderController();
    // The library has been read once the selected voice's controls appear; the
    // panel reports from an effect of that commit.
    await screen.findByRole("button", { name: "Preview" });
    await act(() => Promise.resolve());

    fireEvent.click(startButton());

    await waitFor(() => expect(studio.runRender).toHaveBeenCalledTimes(1));
    expect(studio.builtVoiceProfile).toMatchObject({ customVoiceId: narrator.id });
  });

  it("holds Start render and the provider select while a voice task runs", async () => {
    studio.synthesizePocket.mockReturnValue(new Promise(() => {}));
    renderController();
    expect(startButton()).toBeEnabled();

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    await waitFor(() => expect(startButton()).toBeDisabled());
    expect(
      screen.getByRole("combobox", { name: "Narration language and provider" }),
    ).toBeDisabled();
    expect(screen.getByText('Synthesizing a preview with "Narrator"…')).toBeInTheDocument();
  });
});

// Last: a passing render stays in the module's run history for every later mount.
describe("StudioController draft upload focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    studio.searchParams = new URLSearchParams();
    studio.voices = [];
  });

  it("returns focus to Create draft… when the draft upload closes", async () => {
    studio.runRender.mockResolvedValue({
      report: { planSlug: "english-script", outcome: "passed", checks: [], errors: [] },
      manifest: { planSlug: "english-script", planHash: "0".repeat(64), runtimeMode: "fixture" },
      semantics: null,
      artifacts: {
        neBlob: new Blob(),
        audioBlob: new Blob(),
        audioFileName: "lesson-english-script.m4a",
        recording: {},
      },
    } as unknown as Awaited<ReturnType<typeof runStudioRender>>);
    renderController();

    fireEvent.click(startButton());
    const createDraft = await screen.findByRole("button", { name: "Create draft…" });
    createDraft.focus();
    fireEvent.click(createDraft);
    expect(screen.queryByRole("button", { name: "Create draft…" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close draft upload" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create draft…" })).toHaveFocus(),
    );
  });
});
