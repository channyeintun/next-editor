import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";

const recovery = vi.hoisted(() => ({
  clearIntent: vi.fn<() => Promise<void>>(),
  loadIntent: vi.fn<() => Promise<{ recordingId: string; draft?: { title?: string } } | null>>(),
  loadRecording: vi.fn<(id: string) => Promise<Recording | null>>(),
  uploadModal: vi.fn<() => null>(() => null),
}));

vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("./Editor", () => ({ default: () => null }));

vi.mock("@next-editor/infra", () => ({
  UploadLessonModal: recovery.uploadModal,
  clearResumeIntent: recovery.clearIntent,
  loadResumeIntent: recovery.loadIntent,
  useAuth: () => ({ isSignedIn: true, isLoading: false }),
}));

vi.mock("../storage/RecordingStorage", () => ({
  RecordingStorage: class {
    loadById(id: string) {
      return recovery.loadRecording(id);
    }
  },
}));

const { default: CodeRoute } = await import("./CodeRoute");

const recording: Recording = {
  version: 4,
  id: "resume-recording",
  name: "Resume recording",
  createdAt: 1,
  duration: 100,
  keyframeInterval: 120,
  frames: [],
};

describe("CodeRoute upload recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recovery.loadIntent.mockResolvedValue({
      recordingId: recording.id,
      draft: { title: "Recovered title" },
    });
    recovery.clearIntent.mockResolvedValue();
    recovery.loadRecording.mockResolvedValue(recording);
  });

  it("survives the StrictMode effect replay and clears only after modal handoff", async () => {
    render(
      <StrictMode>
        <CodeRoute />
      </StrictMode>,
    );

    await waitFor(() => expect(recovery.uploadModal).toHaveBeenCalled());
    expect(recovery.loadRecording).toHaveBeenCalledTimes(1);
    expect(recovery.clearIntent).toHaveBeenCalledTimes(1);
  });

  it("retains a transient failure and retries without consuming the intent", async () => {
    recovery.loadRecording
      .mockRejectedValueOnce(new Error("IndexedDB temporarily unavailable"))
      .mockResolvedValue(recording);

    render(<CodeRoute />);

    expect(await screen.findByRole("alert")).toHaveTextContent("IndexedDB temporarily unavailable");
    expect(recovery.clearIntent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(recovery.uploadModal).toHaveBeenCalled());
    expect(recovery.loadRecording).toHaveBeenCalledTimes(2);
    expect(recovery.clearIntent).toHaveBeenCalledTimes(1);
  });
});
