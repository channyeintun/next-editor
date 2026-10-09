import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { getAgentStore } from "../../agent/agentStore";
import { getAgentCredentialStore } from "../../agent/credentials";
import { getAgentSessionStore } from "../../agent/agentSession";
import { WorkspaceStoreContext, type WorkspaceStoreInstance } from "../../stores/workspaceStore";
import AgentPanel from "./AgentPanel";

const metadata = vi.hoisted(() => ({ isPlaying: false, isRecording: false }));

vi.mock("../../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ handleChatEvent: () => {} }),
  useNextEditorMetadata: () => metadata,
}));
vi.mock("../../hooks/useWorkspace", () => ({ useWorkspaceLoadVersion: () => 0 }));
vi.mock("../../contexts/PreviewAdapterHandleContext", () => ({
  usePreviewAdapterHandle: () => ({
    livePreviewInspectionGetter: { current: null },
    previewScreenshotCapturer: { current: null },
  }),
}));
vi.mock("../../hooks/useWebContainerRuntime", () => ({
  useWebContainerRuntimeMetadata: () => ({ isSupported: true }),
  useWebContainerRuntimeSnapshotGetter: () => () => ({}),
}));
vi.mock("./useOpenRouterModelCatalog", () => ({
  useOpenRouterModelCatalog: () => ({
    modelOptions: [],
    isModelCatalogLoading: false,
    modelCatalogError: null,
  }),
}));
// The real session runs the agent loop over the network. Here a run starts the
// way the real one does (isRunning set before its first await) and only ends
// when a test ends it.
vi.mock("../../agent/agentSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/agentSession")>();
  return {
    ...actual,
    synchronizeAgentWorkspace: () => false,
    startAgentRun: vi.fn<typeof actual.startAgentRun>(async () => {
      actual.getAgentSessionStore().trigger.setRunning({ isRunning: true });
    }),
    stopAgentRun: vi.fn<typeof actual.stopAgentRun>(),
  };
});

const workspace = {} as WorkspaceStoreInstance;
const originalScrollIntoView = Element.prototype.scrollIntoView;

function renderPanel() {
  return render(
    <WorkspaceStoreContext.Provider value={workspace}>
      <AgentPanel />
    </WorkspaceStoreContext.Provider>,
  );
}

const composer = () => screen.getByRole("textbox", { name: "Message the agent" });
const endRun = () => act(() => getAgentSessionStore().trigger.setRunning({ isRunning: false }));

beforeAll(() => {
  // jsdom has no scrollIntoView; the panel scrolls the transcript end into view.
  Element.prototype.scrollIntoView = () => {};
});

afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

beforeEach(() => {
  const credentialStore = getAgentCredentialStore();
  credentialStore.trigger.setStorage({ storage: "memory" });
  credentialStore.trigger.setApiKey({ apiKey: "sk-or-test" });
});

afterEach(() => {
  cleanup();
  getAgentCredentialStore().trigger.clear();
  getAgentStore().trigger.reset();
  getAgentSessionStore().trigger.setRunning({ isRunning: false });
  getAgentSessionStore().trigger.clear();
  metadata.isPlaying = false;
  vi.clearAllMocks();
});

describe("AgentPanel composer focus", () => {
  it("keeps focus in the composer after Send and makes it read-only while the run is busy", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Add a footer" } });
    const send = screen.getByRole("button", { name: "Send message" });
    send.focus();

    fireEvent.click(send);

    expect(composer()).toHaveFocus();
    expect(composer()).toHaveAttribute("readonly");
    expect(composer()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("keeps focus in the composer when Enter sends", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Add a footer" } });
    composer().focus();

    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(composer()).toHaveFocus();
    expect(composer()).toHaveAttribute("readonly");
  });

  it("moves focus to the composer on Stop", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Add a footer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const stop = screen.getByRole("button", { name: "Stop agent" });
    stop.focus();

    fireEvent.click(stop);
    endRun();

    expect(composer()).toHaveFocus();
    expect(composer()).not.toHaveAttribute("readonly");
  });

  it("brings focus back to the composer when the run ends while Stop is focused", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Add a footer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    screen.getByRole("button", { name: "Stop agent" }).focus();

    endRun();

    expect(composer()).toHaveFocus();
  });

  it("leaves focus alone when the run ends while the user is elsewhere", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Add a footer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const settings = screen.getByRole("button", { name: "Open agent settings" });
    settings.focus();

    endRun();

    expect(settings).toHaveFocus();
  });

  it("does not take focus when it mounts", () => {
    renderPanel();

    expect(document.body).toHaveFocus();
  });

  it("ignores pasted images while a run is busy", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Add a footer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const image = new File(["x"], "shot.png", { type: "image/png" });

    // The panel takes over (prevents) a paste only when it attaches the images.
    const isPasteLeftAlone = fireEvent.paste(composer(), {
      clipboardData: { items: [], files: [image] },
    });

    expect(isPasteLeftAlone).toBe(true);
    expect(getAgentStore().getSnapshot().context.draftImages).toHaveLength(0);
  });
});

describe("AgentPanel API key hint", () => {
  it("explains why Send is disabled when there is no API key", () => {
    getAgentCredentialStore().trigger.clear();
    renderPanel();

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      "Add an OpenRouter API key in agent settings to send messages.",
    );
  });

  it("shows no hint once a key is set", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Send message" })).not.toHaveAccessibleDescription(
      /OpenRouter/,
    );
    expect(screen.queryByText(/Add an OpenRouter API key/)).toBeNull();
  });

  it("shows no hint during lesson replay", () => {
    getAgentCredentialStore().trigger.clear();
    metadata.isPlaying = true;
    renderPanel();

    expect(screen.queryByText(/Add an OpenRouter API key/)).toBeNull();
  });
});
