import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import RecordingTransportControls from "./RecordingTransportControls";

const actions = vi.hoisted(() => ({
  pauseRecording: vi.fn<() => void>(),
  resumeRecording: vi.fn<() => void>(),
  retakeRecording: vi.fn<() => void>(),
  addChapterMarker: vi.fn<() => void>(),
}));
const take = vi.hoisted(() => ({
  isRecordingPaused: false,
  chapterCount: 0,
  elapsedMs: 65_000,
  retakeTarget: 20_000 as number | null,
}));

vi.mock("../../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => actions,
  useNextEditorMetadata: () => ({ isRecordingPaused: take.isRecordingPaused }),
  useRecordingChapterCount: () => take.chapterCount,
  useRecordingElapsedMs: () => take.elapsedMs,
  useRetakeTargetTime: () => take.retakeTarget,
}));

afterEach(() => {
  vi.clearAllMocks();
  take.isRecordingPaused = false;
  take.chapterCount = 0;
  take.retakeTarget = 20_000;
});

const renderControls = () => render(<RecordingTransportControls iconSize={16} className="w-6" />);

describe("RecordingTransportControls", () => {
  it("pauses a running take and resumes a paused one", () => {
    const { unmount } = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Pause recording" }));
    expect(actions.pauseRecording).toHaveBeenCalledTimes(1);
    unmount();

    take.isRecordingPaused = true;
    renderControls();
    const resume = screen.getByRole("button", { name: "Resume recording" });
    expect(resume).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(resume);
    expect(actions.resumeRecording).toHaveBeenCalledTimes(1);
  });

  it("asks before a retake discards the take since its last resume", () => {
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: "Retake from 0:20 (the last resume)" }));
    expect(actions.retakeRecording).not.toHaveBeenCalled();
    expect(screen.getByText("Discard 0:45?")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Discard the last 0:45 and retake from 0:20" }),
    );
    expect(actions.retakeRecording).toHaveBeenCalledTimes(1);
  });

  it("has nothing to retake before a safe point", () => {
    take.retakeTarget = null;
    renderControls();

    expect(screen.getByRole("button", { name: "Nothing to retake yet" })).toBeDisabled();
  });

  it("marks chapters and counts them", () => {
    take.chapterCount = 2;
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: "Mark a chapter here (2 marked so far)" }));
    expect(actions.addChapterMarker).toHaveBeenCalledTimes(1);
  });
});
