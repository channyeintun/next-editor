import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MockInstance } from "vite-plus/test";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import type { WorkspaceLessonType, WorkspaceProject } from "../types/workspace";

const mocks = vi.hoisted(() => {
  // The order the workspace swap's steps ran in, across all four spies.
  const swapCalls: string[] = [];
  const project = { id: "swapped-in" } as WorkspaceProject;
  return {
    swapCalls,
    project,
    downloadWorkspaceProjectAsZip: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    startTour: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    setSidebarCollapsed: vi.fn<(collapsed: boolean) => void>(),
    setWhiteboardOpen: vi.fn<(open: boolean) => void>(),
    createStarterWorkspaceForLessonType: vi.fn<
      (lessonType: WorkspaceLessonType) => Promise<WorkspaceProject>
    >(() => Promise.resolve(project)),
    importWorkspaceProjectFromZip: vi.fn<(file: File) => Promise<WorkspaceProject>>(() =>
      Promise.resolve(project),
    ),
    resetRuntime: vi.fn<() => void>(() => {
      swapCalls.push("resetRuntime");
    }),
    reconcileExternalProject: vi.fn<(project: WorkspaceProject) => void>(() => {
      swapCalls.push("reconcileExternalProject");
    }),
    saveProject: vi.fn<() => Promise<void>>(() => {
      swapCalls.push("saveProject");
      return Promise.resolve();
    }),
    updateRunnerConfig: vi.fn<(config: { enabled: boolean }) => void>(() => {
      swapCalls.push("updateRunnerConfig");
    }),
  };
});

let lessonType: WorkspaceLessonType = "react";
let sidebarCollapsed = false;
let whiteboardOpen = false;

vi.mock("../hooks/useWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useWorkspace")>()),
  useWorkspaceActions: () => ({
    getProject: () => ({}),
    reconcileExternalProject: mocks.reconcileExternalProject,
    saveProject: mocks.saveProject,
    setSidebarCollapsed: mocks.setSidebarCollapsed,
  }),
  useWorkspaceDirtyState: () => ({ hasUnsavedChanges: false }),
  useWorkspaceFileCount: () => 0,
  useWorkspaceLessonType: () => lessonType,
  useWorkspaceSidebarCollapsed: () => sidebarCollapsed,
}));
vi.mock("../contexts/WhiteboardContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contexts/WhiteboardContext")>()),
  useWhiteboardContext: () => ({ isOpen: whiteboardOpen, setOpen: mocks.setWhiteboardOpen }),
}));
vi.mock("../contexts/SlidesContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contexts/SlidesContext")>()),
  useSlidesContext: () => ({ previewState: { isOpen: false } }),
}));
vi.mock("../contexts/CollaborationContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contexts/CollaborationContext")>()),
  useOptionalCollaboration: () => null,
}));
vi.mock("../hooks/useNextEditorContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useNextEditorContext")>()),
  useNextEditorActions: () => ({}),
  useNextEditorMetadata: () => ({ currentRecording: null }),
}));
vi.mock("../hooks/useWebContainerRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useWebContainerRuntime")>()),
  useWebContainerRuntimeActions: () => ({
    resetRuntime: mocks.resetRuntime,
    updateRunnerConfig: mocks.updateRunnerConfig,
  }),
  useWebContainerRuntimeMetadata: () => ({
    environmentVariables: {},
    runnerConfig: { enabled: false },
    status: "ready",
  }),
}));
vi.mock("../utils/workspaceZip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/workspaceZip")>()),
  downloadWorkspaceProjectAsZip: mocks.downloadWorkspaceProjectAsZip,
}));
vi.mock("../utils/workspaceZipImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/workspaceZipImport")>()),
  importWorkspaceProjectFromZip: mocks.importWorkspaceProjectFromZip,
}));
vi.mock("../starters", () => ({
  createStarterWorkspaceForLessonType: mocks.createStarterWorkspaceForLessonType,
}));
vi.mock("./tour/productTour", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tour/productTour")>()),
  startTour: mocks.startTour,
}));

import {
  FileSidebarToggleButton,
  PreviewHeaderButton,
  WhiteboardHeaderButton,
} from "./EditorHeader";
import WorkspaceSettingsButton from "./editorHeader/WorkspaceSettingsButton";

describe("PreviewHeaderButton", () => {
  it("opens the preview on the first click, keeping its name and reporting it pressed", () => {
    render(
      <PreviewAdapterHandleProvider>
        <PreviewPanelProvider>
          <PreviewHeaderButton />
        </PreviewPanelProvider>
      </PreviewAdapterHandleProvider>,
    );

    const button = screen.getByRole("button", { name: "Preview" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAccessibleDescription("Open preview");

    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAccessibleDescription("Close preview");
  });
});

describe("FileSidebarToggleButton", () => {
  beforeEach(() => {
    mocks.setSidebarCollapsed.mockClear();
  });

  it("keeps the name File explorer and reports the open sidebar as pressed", () => {
    sidebarCollapsed = false;
    const { rerender } = render(<FileSidebarToggleButton />);
    const button = screen.getByRole("button", { name: "File explorer" });

    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(mocks.setSidebarCollapsed).toHaveBeenCalledWith(true);

    sidebarCollapsed = true;
    rerender(<FileSidebarToggleButton />);

    expect(screen.getByRole("button", { name: "File explorer" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("WhiteboardHeaderButton", () => {
  beforeEach(() => {
    mocks.setWhiteboardOpen.mockClear();
  });

  it("keeps the name Whiteboard and reports the open whiteboard as pressed", () => {
    whiteboardOpen = false;
    const { rerender } = render(<WhiteboardHeaderButton />);
    const button = screen.getByRole("button", { name: "Whiteboard" });

    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(mocks.setWhiteboardOpen).toHaveBeenCalledWith(true);

    whiteboardOpen = true;
    rerender(<WhiteboardHeaderButton />);

    expect(screen.getByRole("button", { name: "Whiteboard" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("WorkspaceSettingsButton", () => {
  beforeEach(() => {
    lessonType = "react";
    mocks.downloadWorkspaceProjectAsZip.mockClear();
    mocks.startTour.mockClear();
  });

  // Opens the menu the way a keyboard user does: focus on the button, then
  // activate it, then move focus onto the item that is about to be chosen.
  function openMenuAndFocus(itemName: string) {
    render(<WorkspaceSettingsButton showImportExport />);
    const settingsButton = screen.getByRole("button", { name: "Open workspace settings" });
    settingsButton.focus();
    fireEvent.click(settingsButton);
    const item = screen.getByRole("menuitem", { name: itemName });
    item.focus();
    return { settingsButton, item };
  }

  it("closes on Escape and keeps focus on the Settings button", () => {
    const { settingsButton, item } = openMenuAndFocus("Download As Zip");

    fireEvent.keyDown(item, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(settingsButton).toHaveAttribute("aria-expanded", "false");
    expect(settingsButton).toHaveFocus();
  });

  it("gives focus back to the Settings button after an action closes the menu", async () => {
    const { settingsButton, item } = openMenuAndFocus("Download As Zip");

    await act(async () => {
      fireEvent.click(item);
    });

    expect(mocks.downloadWorkspaceProjectAsZip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(settingsButton).toHaveFocus();
  });

  it("leaves focus to the tour when Take a Tour closes the menu", () => {
    const { settingsButton, item } = openMenuAndFocus("Take a Tour");

    fireEvent.click(item);

    expect(mocks.startTour).toHaveBeenCalledWith({ force: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(settingsButton).not.toHaveFocus();
  });

  it("returns focus from the environment dialog to the Settings button", () => {
    const { settingsButton, item } = openMenuAndFocus("Edit Environment");

    fireEvent.click(item);

    expect(screen.getByRole("dialog", { name: "Edit Environment" })).toBeInTheDocument();
    expect(screen.getByLabelText("Environment variables")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(settingsButton).toHaveFocus();
  });

  describe("replacing the workspace", () => {
    let confirm: MockInstance<typeof window.confirm>;

    beforeEach(() => {
      mocks.swapCalls.length = 0;
      mocks.createStarterWorkspaceForLessonType.mockClear();
      mocks.reconcileExternalProject.mockClear();
      mocks.updateRunnerConfig.mockClear();
      confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    });

    afterEach(() => {
      confirm.mockRestore();
    });

    // The reset comes first, in the same task as the swap, and never after the
    // save: the swap's render auto-starts the new project, which a later reset
    // would cancel.
    const RESET_THEN_SWAP = [
      "resetRuntime",
      "reconcileExternalProject",
      "saveProject",
      "updateRunnerConfig",
    ];

    it("resets the runtime before swapping in a different starter, then saves and runs it", async () => {
      openMenuAndFocus("Starter Template");
      fireEvent.click(screen.getByRole("menuitem", { name: "Starter Template" }));

      await act(async () => {
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Vue" }));
      });

      expect(mocks.createStarterWorkspaceForLessonType).toHaveBeenCalledWith("vue");
      expect(mocks.reconcileExternalProject).toHaveBeenCalledWith(mocks.project);
      expect(mocks.swapCalls).toEqual(RESET_THEN_SWAP);
      expect(mocks.updateRunnerConfig).toHaveBeenCalledWith({ enabled: true });
    });

    it("swaps a fresh starter of the same framework in for New Editor without a reset", async () => {
      const { item } = openMenuAndFocus("New Editor");

      await act(async () => {
        fireEvent.click(item);
      });

      expect(mocks.createStarterWorkspaceForLessonType).toHaveBeenCalledWith("react");
      expect(mocks.swapCalls).toEqual([
        "reconcileExternalProject",
        "saveProject",
        "updateRunnerConfig",
      ]);
      expect(mocks.updateRunnerConfig).toHaveBeenCalledWith({ enabled: true });
    });

    it("resets the runtime before swapping in an imported zip, then saves and runs it", async () => {
      const { container } = render(<WorkspaceSettingsButton showImportExport />);
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("expected the zip file input");

      await act(async () => {
        fireEvent.change(input, {
          target: { files: [new File(["zip"], "project.zip", { type: "application/zip" })] },
        });
      });

      expect(mocks.reconcileExternalProject).toHaveBeenCalledWith(mocks.project);
      expect(mocks.swapCalls).toEqual(RESET_THEN_SWAP);
      expect(mocks.updateRunnerConfig).toHaveBeenCalledWith({ enabled: true });
    });
  });
});
