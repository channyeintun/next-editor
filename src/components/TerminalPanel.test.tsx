import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  WebContainerRuntimeOutputContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeOutput,
} from "../contexts/WebContainerRuntimeContext";
import type { WebContainerRuntimeStatus } from "../runtime/webcontainer/types";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import TerminalPanel from "./TerminalPanel";

// The WebContainer dock with its runtime given through the real contexts; the
// editor session, the xterm surfaces and the agent are stand-ins.
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ handleRuntimeEvent: () => {} }),
  useNextEditorMetadata: () => ({
    currentRecording: null,
    isRecording: false,
    isPlaying: false,
    isReplayLoaded: false,
  }),
}));
vi.mock("./XtermTerminal", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: { label: string; output: string }) =>
      createElement("pre", { "data-testid": props.label }, props.output),
  };
});
vi.mock("./agent/AgentPanel", () => ({ default: () => null }));

const actions = {
  clearRunnerOutput: () => {},
  closeTerminalSession: () => {},
  createTerminalSession: async () => {},
  rerunRunner: async () => {},
  resizeTerminal: () => {},
  sendTerminalInput: async () => {},
  setActiveTerminalSession: () => {},
  startTerminalSession: async () => {},
  updateRunnerConfig: () => {},
} as unknown as WebContainerRuntimeActions;

function dock(
  status: WebContainerRuntimeStatus,
  terminalSessions: WebContainerRuntimeOutput["terminalSessions"] = [],
) {
  const metadata = {
    activeTerminalSessionId: terminalSessions[0]?.id ?? null,
    status,
    errorMessage: null,
    previewPort: null,
    previewUrl: null,
    runnerConfig: { enabled: true, runCommand: "npm run dev", initCommand: "npm install" },
  } as unknown as WebContainerRuntimeMetadata;
  const output: WebContainerRuntimeOutput = {
    lastOutput: null,
    terminalSessions,
    latestPreviewMessage: null,
    latestLifecycleEvent: null,
  };

  return (
    <RuntimePanelStoreProvider>
      <WebContainerRuntimeActionsContext value={actions}>
        <WebContainerRuntimeMetadataContext value={metadata}>
          <WebContainerRuntimeOutputContext value={output}>
            <TerminalPanel />
          </WebContainerRuntimeOutputContext>
        </WebContainerRuntimeMetadataContext>
      </WebContainerRuntimeActionsContext>
    </RuntimePanelStoreProvider>
  );
}

describe("TerminalPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("says in its status region that the runner is starting, and hides the spinner", () => {
    const view = render(dock("ready"));
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    view.rerender(dock("installing"));

    expect(status.textContent).toBe("Runner is starting");
    // The spinner is decoration: the status region carries its meaning.
    expect(screen.queryByLabelText("Runner is starting")).toBeNull();
    expect(document.querySelector(".animate-spin")).toHaveAttribute("aria-hidden", "true");

    view.rerender(dock("ready"));

    expect(status).toBeEmptyDOMElement();
  });

  it("keeps its status region mounted on every tab and while collapsed", () => {
    render(dock("starting"));
    const status = screen.getByRole("status");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Console" }));
    });
    expect(screen.getByTestId("Console")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(status);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse runtime dock" }));
    });
    expect(screen.queryByTestId("Console")).toBeNull();
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Runner is starting");
  });

  it("marks the dock tab on screen as pressed", () => {
    render(dock("ready"));
    const pressed = () =>
      ["Runner", "Console", "Agent"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      );
    expect(pressed()).toEqual(["true", "false", "false"]);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Console" }));
    });

    expect(pressed()).toEqual(["false", "true", "false"]);
  });

  it("hooks the tour's Runner step and its dock lookup on the collapse toggle", () => {
    render(dock("ready"));

    const collapse = screen.getByRole("button", { name: "Collapse runtime dock" });
    expect(collapse).toHaveAttribute("data-tour", "runner");
    expect(collapse).toHaveAttribute("data-runtime-dock-toggle");
    expect(collapse).not.toHaveAttribute("data-studio-target");
  });

  it("marks the terminal session on screen as pressed", () => {
    render(
      dock("ready", [
        { id: "shell-1", title: "Terminal 1", output: "" },
        { id: "shell-2", title: "Terminal 2", output: "" },
      ]),
    );
    expect(screen.getByRole("button", { name: "Terminal 1" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Terminal 1" }));
    });

    expect(screen.getByRole("button", { name: "Terminal 1", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal 2", pressed: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Runner", pressed: false })).toBeInTheDocument();
    // The close button beside each session stays a plain button.
    expect(screen.getAllByRole("button", { name: "Close terminal" })[0]).not.toHaveAttribute(
      "aria-pressed",
    );
  });
});
