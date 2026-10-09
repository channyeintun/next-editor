import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type {
  deleteLearnerWorkspaceVersion,
  LearnerWorkspaceVersion,
  listLearnerWorkspaceVersions,
  saveLearnerWorkspaceVersion,
} from "../storage/learnerWorkspaceVersions";
import {
  getLearnerVersionsStore,
  resetLearnerVersionsStoreForTests,
} from "../stores/learnerVersionsStore";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";
import LearnerVersionsMenu from "./LearnerVersionsMenu";

const mocks = vi.hoisted(() => ({
  restoreLearnerWorkspace: vi.fn<NextEditorActions["restoreLearnerWorkspace"]>(),
  listLearnerWorkspaceVersions: vi.fn<typeof listLearnerWorkspaceVersions>(),
  deleteLearnerWorkspaceVersion: vi.fn<typeof deleteLearnerWorkspaceVersion>(),
}));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ restoreLearnerWorkspace: mocks.restoreLearnerWorkspace }),
}));
vi.mock("../storage/learnerWorkspaceVersions", () => ({
  listLearnerWorkspaceVersions: mocks.listLearnerWorkspaceVersions,
  deleteLearnerWorkspaceVersion: mocks.deleteLearnerWorkspaceVersion,
  saveLearnerWorkspaceVersion: vi.fn<typeof saveLearnerWorkspaceVersion>(),
}));

const snapshot = {} as WorkspaceRecordingSnapshot;
const version = (id: string, recordingTime: number): LearnerWorkspaceVersion => ({
  id,
  recordingId: "lesson",
  recordingTime,
  savedAt: Date.now(),
  snapshot,
});
const SAVED = [version("late", 65_000), version("early", 5_000)];

const renderMenu = () =>
  render(<LearnerVersionsMenu recordingId="lesson" iconSize={16} buttonClassName="" />);

beforeEach(() => {
  resetLearnerVersionsStoreForTests();
  mocks.listLearnerWorkspaceVersions.mockResolvedValue(SAVED);
  mocks.deleteLearnerWorkspaceVersion.mockResolvedValue();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LearnerVersionsMenu", () => {
  it("names the button by what it holds and discloses the saved edits as a group", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Your edits, 2 saved" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-haspopup");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const popup = screen.getByRole("group", { name: "Your edits" });
    expect(trigger).toHaveAttribute("aria-controls", popup.id);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restore edits at 1:05/ })).toBeInTheDocument();
  });

  it("restores a version, closes the list and returns focus to the button", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Your edits, 2 saved" });
    fireEvent.click(trigger);

    const restoreButton = screen.getByRole("button", { name: /Restore edits at 0:05/ });
    restoreButton.focus();
    fireEvent.click(restoreButton);

    expect(mocks.restoreLearnerWorkspace).toHaveBeenCalledWith(5_000, snapshot);
    expect(screen.queryByRole("group", { name: "Your edits" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the button when Escape closes the list", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Your edits, 2 saved" });
    fireEvent.click(trigger);
    screen.getByRole("button", { name: /Restore edits at 1:05/ }).focus();

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });

    expect(screen.queryByRole("group", { name: "Your edits" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps the live region mounted before the first save so that save is announced", async () => {
    mocks.listLearnerWorkspaceVersions.mockResolvedValue([]);
    const { container } = renderMenu();
    await act(async () => {});

    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent("");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => {
      getLearnerVersionsStore().trigger.saved({
        recordingId: "lesson",
        versions: [version("first", 30_000)],
        savedAt: Date.now(),
      });
    });

    expect(container.querySelector('[aria-live="polite"]')).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent("Your edits were saved");
    expect(screen.getByRole("button", { name: "Your edits, 1 saved" })).toBeInTheDocument();
  });

  it("asks before deleting a saved version, and Keep leaves it in place", async () => {
    renderMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Your edits, 2 saved" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete edits saved at 1:05" }));

    expect(mocks.deleteLearnerWorkspaceVersion).not.toHaveBeenCalled();
    expect(screen.getByText("Delete these edits?")).toBeInTheDocument();
    const keep = screen.getByRole("button", { name: "Keep" });
    expect(keep).toHaveFocus();
    expect(keep).toHaveAccessibleDescription("Delete these edits?");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAccessibleDescription(
      "Delete these edits?",
    );

    fireEvent.click(keep);

    expect(mocks.deleteLearnerWorkspaceVersion).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete these edits?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete edits saved at 1:05" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Your edits, 2 saved" })).toBeInTheDocument();
  });

  it("deletes a saved version once confirmed and returns focus to the button", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Your edits, 2 saved" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Delete edits saved at 1:05" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(mocks.deleteLearnerWorkspaceVersion).toHaveBeenCalledWith("late");
    expect(trigger).toHaveAccessibleName("Your edits, 1 saved");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Restore edits at 1:05/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restore edits at 0:05/ })).toBeInTheDocument();
  });

  it("drops an unanswered delete question when the list closes", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Your edits, 2 saved" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Delete edits saved at 1:05" }));

    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(screen.queryByText("Delete these edits?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete edits saved at 1:05" })).toBeInTheDocument();
    expect(mocks.deleteLearnerWorkspaceVersion).not.toHaveBeenCalled();
  });
});
