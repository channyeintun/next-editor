import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { useSlidesContext } from "../contexts/SlidesContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";

// Monaco itself is not under test: the workspace's own markup is. Each model
// helper becomes a stand-in, and the editor view renders nothing.
vi.mock("../monaco", () => ({
  monaco: {},
  MonacoEditor: () => null,
  getEditorOptions: () => ({}),
  syncWorkspaceModel: () => ({ uri: { toString: () => "file:///index.html" } }),
  getOrCreatePlaybackModel: () => ({ uri: { toString: () => "playback:///index.html" } }),
  acknowledgeWorkspaceModelContent: () => {},
  disposePlaybackModels: () => {},
  disposeRemovedWorkspaceModels: () => [],
  isPlaybackModelUri: () => false,
  toMonacoModelPath: (path: string) => path,
  toPlaybackModelPath: (path: string) => path,
  workspacePathFromMonacoModelUri: () => null,
}));

// One focusable control stands in for the header; the other workspace panels
// and the overlays' own (heavy) surfaces are left out.
vi.mock("./EditorHeader", () => ({
  default: () => (
    <button type="button" data-testid="header-control">
      Header control
    </button>
  ),
}));
vi.mock("./FileSidebar", () => ({ default: () => null }));
vi.mock("./TerminalPanel", () => ({ default: () => null }));
vi.mock("./Preview", () => ({ default: () => null }));
vi.mock("./WorkspaceEventRecorder", () => ({ WorkspaceEventRecorder: () => null }));
vi.mock("./SlidePanel", () => ({ default: () => null }));
vi.mock("./whiteboardPanelLoader", () => ({
  loadWhiteboardPanel: async () => ({ default: () => null }),
}));

const { default: Editor } = await import("./Editor");

/** Opens and closes the overlays the way playback, a presenter or the header would. */
function OverlayControls() {
  const whiteboard = useWhiteboardContext();
  const slides = useSlidesContext();
  const openSlides = (isMaximized: boolean) =>
    slides.handleSlideEvent({
      type: "slide_open",
      timestamp: 0,
      slideId: "slide-1",
      isMaximized,
    });
  return (
    <div>
      <button type="button" onClick={() => whiteboard.setOpen(!whiteboard.isOpen)}>
        Toggle whiteboard
      </button>
      <button type="button" onClick={() => openSlides(true)}>
        Present slides
      </button>
      <button type="button" onClick={() => openSlides(false)}>
        Open slides inline
      </button>
      <button type="button" onClick={() => slides.closePresentation()}>
        Close slides
      </button>
    </div>
  );
}

async function renderWorkspace() {
  // CollaborationProvider reads the signed-in user through react-query.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Editor
          readOnly
          runtimeAutoStart={false}
          recordingDrafts={false}
          persistWorkspace={false}
          overlay={<OverlayControls />}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // CodeEditor is a lazy chunk; its first import transforms the whole workspace graph.
  const headerControl = await screen.findByTestId("header-control", {}, { timeout: 20_000 });
  const workspace = headerControl.closest("[data-cursor-replay-target='workspace']");
  if (!workspace) throw new Error("The header control is not inside the workspace root");
  return workspace;
}

function press(name: string) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("CodeEditor bypass block", () => {
  it("skips the header to the main editor region without navigating", async () => {
    await renderWorkspace();
    const main = screen.getByRole("main");
    const headerControl = screen.getByTestId("header-control");
    const skipLink = screen.getByRole("link", { name: "Skip to editor" });

    expect(main).not.toContainElement(headerControl);
    expect(
      skipLink.compareDocumentPosition(headerControl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    let followedHref = true;
    act(() => {
      followedHref = fireEvent.click(skipLink);
    });
    expect(followedHref).toBe(false);
    expect(main).toHaveFocus();
  });
});

describe("CodeEditor workspace under an overlay", () => {
  it("is inert while the whiteboard covers it", async () => {
    const workspace = await renderWorkspace();
    expect(workspace).not.toHaveAttribute("inert");

    press("Toggle whiteboard");
    expect(workspace).toHaveAttribute("inert");

    press("Toggle whiteboard");
    expect(workspace).not.toHaveAttribute("inert");
  });

  it("is inert while a maximized slide covers it", async () => {
    const workspace = await renderWorkspace();

    press("Present slides");
    expect(workspace).toHaveAttribute("inert");

    press("Close slides");
    expect(workspace).not.toHaveAttribute("inert");
  });

  it("stays operable while slides are open but not drawn over it", async () => {
    const workspace = await renderWorkspace();

    press("Open slides inline");
    expect(workspace).not.toHaveAttribute("inert");
  });
});
