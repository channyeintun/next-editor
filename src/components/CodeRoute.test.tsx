import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";

const recovery = vi.hoisted(() => ({
  auth: { isSignedIn: true, isLoading: false },
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
  useAuth: () => recovery.auth,
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
    recovery.auth.isSignedIn = true;
    recovery.auth.isLoading = false;
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

  it("retains the intent when loading the recovery pointer fails", async () => {
    recovery.loadIntent.mockRejectedValueOnce(new Error("resume store unavailable"));

    render(<CodeRoute />);

    expect(await screen.findByRole("alert")).toHaveTextContent("resume store unavailable");
    expect(recovery.loadRecording).not.toHaveBeenCalled();
    expect(recovery.clearIntent).not.toHaveBeenCalled();
  });

  it("consumes a terminal missing-recording intent", async () => {
    recovery.loadRecording.mockResolvedValueOnce(null);

    render(<CodeRoute />);

    await waitFor(() => expect(recovery.clearIntent).toHaveBeenCalledTimes(1));
    expect(recovery.uploadModal).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("consumes the intent when sign-in was cancelled", async () => {
    recovery.auth.isSignedIn = false;

    render(<CodeRoute />);

    await waitFor(() => expect(recovery.clearIntent).toHaveBeenCalledTimes(1));
    expect(recovery.loadRecording).not.toHaveBeenCalled();
    expect(recovery.uploadModal).not.toHaveBeenCalled();
  });

  it("does nothing after unmount while the intent load is pending", async () => {
    let resolveIntent: ((intent: { recordingId: string }) => void) | null = null;
    recovery.loadIntent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIntent = resolve;
        }),
    );
    const view = render(<CodeRoute />);

    view.unmount();
    await act(async () => {
      resolveIntent?.({ recordingId: recording.id });
      await Promise.resolve();
    });

    expect(recovery.loadRecording).not.toHaveBeenCalled();
    expect(recovery.clearIntent).not.toHaveBeenCalled();
  });

  it("does not hand off or clear after unmount during recording load", async () => {
    let resolveRecording: ((value: Recording | null) => void) | null = null;
    recovery.loadRecording.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecording = resolve;
        }),
    );
    const view = render(<CodeRoute />);
    await waitFor(() => expect(recovery.loadRecording).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      resolveRecording?.(recording);
      await Promise.resolve();
    });

    expect(recovery.uploadModal).not.toHaveBeenCalled();
    expect(recovery.clearIntent).not.toHaveBeenCalled();
  });
});
