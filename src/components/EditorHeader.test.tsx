import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import type { WorkspaceLessonType } from "../types/workspace";

const mocks = vi.hoisted(() => ({
  downloadWorkspaceProjectAsZip: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  startTour: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

let lessonType: WorkspaceLessonType = "react";

vi.mock("../hooks/useWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useWorkspace")>()),
  useWorkspaceActions: () => ({
    getProject: () => ({}),
    reconcileExternalProject: () => {},
    saveProject: () => Promise.resolve(),
  }),
  useWorkspaceDirtyState: () => ({ hasUnsavedChanges: false }),
  useWorkspaceFileCount: () => 0,
  useWorkspaceLessonType: () => lessonType,
}));
vi.mock("../hooks/useNextEditorContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useNextEditorContext")>()),
  useNextEditorActions: () => ({}),
  useNextEditorMetadata: () => ({ currentRecording: null }),
}));
vi.mock("../hooks/useWebContainerRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useWebContainerRuntime")>()),
  useWebContainerRuntimeActions: () => ({}),
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
vi.mock("./tour/productTour", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tour/productTour")>()),
  startTour: mocks.startTour,
}));

import { PreviewHeaderButton, WorkspaceSettingsButton } from "./EditorHeader";

describe("PreviewHeaderButton", () => {
  it("opens the preview on the first click", () => {
    render(
      <PreviewAdapterHandleProvider>
        <PreviewPanelProvider>
          <PreviewHeaderButton />
        </PreviewPanelProvider>
      </PreviewAdapterHandleProvider>,
    );

    const button = screen.getByRole("button", { name: "Open preview" });
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "Close preview" })).toHaveAttribute(
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
});
