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
import { getAgentSessionStore, resolveConfirmation } from "../../agent/agentSession";
import { MAX_CHAT_IMAGES } from "../../agent/imageAttachments";
import type { ChatStatus } from "../../types/chat";
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
    resolveConfirmation: vi.fn<typeof actual.resolveConfirmation>((id) => {
      actual.getAgentSessionStore().trigger.remove({ id });
    }),
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
  getAgentStore().trigger.applyReplaySnapshot({ snapshot: null });
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

describe("AgentPanel tool permission", () => {
  function askPermission() {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "Run the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    act(() =>
      getAgentSessionStore().trigger.enqueue({
        item: { id: 7, request: { toolName: "bash", summary: "npm test" } },
      }),
    );
  }

  it("announces the request as an alert", () => {
    askPermission();

    expect(screen.getByRole("alert")).toHaveTextContent("Allow bash to run this command?");
  });

  it.each([
    ["Allow", true],
    ["Deny", false],
  ])("moves focus to the composer after %s", (name, approved) => {
    askPermission();
    const answer = screen.getByRole("button", { name });
    answer.focus();

    fireEvent.click(answer);

    expect(resolveConfirmation).toHaveBeenCalledWith(7, approved);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(composer()).toHaveFocus();
  });
});

describe("AgentPanel status announcements", () => {
  const setStatus = (status: ChatStatus) =>
    act(() => getAgentStore().trigger.applyDelta({ delta: { k: "status", status } }));
  const runStatus = () => screen.getAllByRole("status")[0];

  it("announces run progress in one status region and leaves errors to the error alert", () => {
    renderPanel();
    const region = runStatus();
    expect(region).toBeEmptyDOMElement();

    setStatus("streaming");
    expect(runStatus()).toBe(region);
    expect(region).toHaveTextContent("Agent is working");
    expect(screen.queryByLabelText("Agent is working")).toBeNull();

    setStatus("waiting-confirmation");
    expect(region).toHaveTextContent("The agent needs your permission to run a command");

    setStatus("done");
    expect(region).toHaveTextContent("Agent finished");

    setStatus("error");
    expect(region).toBeEmptyDOMElement();
  });

  it("stays silent while a lesson replays", () => {
    metadata.isPlaying = true;
    act(() =>
      getAgentStore().trigger.applyReplaySnapshot({ snapshot: { items: [], status: "streaming" } }),
    );
    renderPanel();

    expect(screen.getByText("Streaming…")).toBeInTheDocument();
    expect(runStatus()).toBeEmptyDOMElement();
  });

  it("announces attachment errors in a status region that is always there", () => {
    act(() =>
      getAgentStore().trigger.addDraftImages({
        images: Array.from({ length: MAX_CHAT_IMAGES }, (_, index) => ({
          id: `image-${index}`,
          dataUrl: "data:image/png;base64,AA==",
          mimeType: "image/png",
        })),
      }),
    );
    renderPanel();
    const [, attachmentStatus] = screen.getAllByRole("status");
    expect(attachmentStatus).toBeEmptyDOMElement();
    const image = new File(["x"], "shot.png", { type: "image/png" });

    fireEvent.paste(composer(), { clipboardData: { items: [], files: [image] } });

    expect(attachmentStatus).toHaveTextContent(`You can attach up to ${MAX_CHAT_IMAGES} images.`);
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
