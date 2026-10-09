import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { runStudioRender } from "./runStudioRender";
import type { SavedCustomVoice } from "./tts/customVoices";

const studio = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  runRender: vi.fn<typeof runStudioRender>(),
  voices: [] as SavedCustomVoice[],
  synthesizePocket: vi.fn<() => Promise<Uint8Array>>(),
}));

vi.mock("react-router", () => ({
  useSearchParams: () => [studio.searchParams, () => {}],
}));

vi.mock("@next-editor/infra", () => ({
  invalidateAthanLabAccount: () => Promise.resolve(),
  UploadLessonModal: () => null,
  useAuth: () => ({ user: null, isLoading: false }),
  useStudioCapabilities: () => ({
    capabilities: { athanlab: false, burmeseVoxCpm2: false },
    isLoading: false,
  }),
}));

vi.mock("./AthanLabPanel", () => ({ default: () => null }));
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
vi.mock("./inPageDirector", () => ({
  buildPlanFromScript: () => Promise.reject(new Error("unused")),
}));
vi.mock("./runStudioRender", () => ({ runStudioRender: studio.runRender }));
vi.mock("./tts/pocketSynth", () => ({ synthesizePocketWav: studio.synthesizePocket }));
vi.mock("./tts/modalVoxCpm2Synth", () => ({
  synthesizeModalVoxCpm2Wav: () => Promise.reject(new Error("unused")),
}));
vi.mock("./tts/customVoices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tts/customVoices")>()),
  listCustomVoices: () => Promise.resolve(studio.voices),
  deleteCustomVoice: () => Promise.resolve(),
}));
// One English plan that can start with the default English provider, and one
// Burmese script that cannot.
vi.mock("./plans", () => ({
  DEFAULT_STUDIO_PLAN_SLUG: "english-plan",
  STUDIO_SOURCES: {
    "english-plan": {
      kind: "plan",
      load: () => ({
        lesson: { slug: "english-plan", title: "English plan" },
        runtime: { kind: "none" },
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
  },
  parseLessonScriptYaml: () => {
    throw new Error("unused");
  },
  sourceRuntimeDefault: () => "fixture",
  sourceTitle: (source: { load: () => { lesson: { title: string } } }) =>
    source.load().lesson.title,
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

function renderController() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <StudioController />
    </QueryClientProvider>,
  );
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

  it("announces a voice task through the always-mounted voice status region", async () => {
    studio.voices = [narrator];
    localStorage.setItem("next-editor:studio:voice-choice", narrator.id);
    studio.synthesizePocket.mockReturnValue(new Promise(() => {}));
    renderController();

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    const notice = await screen.findByText('Synthesizing a preview with "Narrator"…');
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });
});

describe("StudioController voice focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    studio.searchParams = new URLSearchParams();
    studio.voices = [narrator];
    localStorage.setItem("next-editor:studio:voice-choice", narrator.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the voice delete button by its action and hides the glyph", async () => {
    renderController();

    const remove = await screen.findByRole("button", { name: "Delete voice" });
    expect(remove).toHaveTextContent("✕");
    expect(remove.querySelector('[aria-hidden="true"]')).toHaveTextContent("✕");
  });

  it("keeps focus on the voice select after deleting the selected voice", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderController();
    const remove = await screen.findByRole("button", { name: "Delete voice" });

    studio.voices = [];
    remove.focus();
    fireEvent.click(remove);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Narrator voice" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Delete voice" })).toBeNull();
  });
});
