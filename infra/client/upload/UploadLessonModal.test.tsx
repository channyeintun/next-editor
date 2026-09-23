import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "@app/core/src";

const signIn = vi.hoisted(() => ({
  calls: [] as string[],
  saveRecording: vi.fn<(recording: Recording) => Promise<void>>(),
  saveResumeIntent: vi.fn<(intent: unknown) => Promise<void>>(),
}));

vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({ isSignedIn: false, isLoading: false }),
  signInUrl: (returnTo: string) => `/api/auth/google/login?returnTo=${returnTo}`,
}));

vi.mock("./useUploadLesson", () => ({
  useUploadLesson: () => ({
    upload: vi.fn<() => Promise<never>>(),
    cancel: vi.fn<() => void>(),
    progress: 0,
    isUploading: false,
    error: null,
    reset: vi.fn<() => void>(),
  }),
  usePublishLesson: () => ({ mutateAsync: vi.fn<() => Promise<void>>() }),
  formatDuration: () => "0:01",
}));

vi.mock("@posthog/react", () => ({ usePostHog: () => undefined }));

vi.mock("@app/storage/RecordingStorage", () => ({
  createRecordingStorage: () => ({ save: signIn.saveRecording }),
}));

vi.mock("./resumeIntent", () => ({ saveResumeIntent: signIn.saveResumeIntent }));

const { default: UploadLessonModal } = await import("./UploadLessonModal");

const recording: Recording = {
  version: 4,
  id: "take-1",
  name: "Take",
  createdAt: 1,
  duration: 1000,
  keyframeInterval: 120,
  frames: [],
};

describe("UploadLessonModal sign-in redirect", () => {
  const originalLocation = window.location;
  let location: { href: string; pathname: string };

  beforeEach(() => {
    signIn.calls.length = 0;
    signIn.saveRecording.mockReset().mockImplementation(async () => {
      signIn.calls.push("save recording");
    });
    signIn.saveResumeIntent.mockReset().mockImplementation(async () => {
      signIn.calls.push("save intent");
    });
    location = { href: "/code", pathname: "/code" };
    Object.defineProperty(window, "location", { configurable: true, value: location });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("stores the take, then the pointer to it, before leaving for sign-in", async () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    await waitFor(() => expect(location.href).toBe("/api/auth/google/login?returnTo=/code"));
    expect(signIn.saveRecording).toHaveBeenCalledWith(recording);
    expect(signIn.saveResumeIntent).toHaveBeenCalledWith({
      recordingId: recording.id,
      returnTo: "/code",
      draft: undefined,
    });
    expect(signIn.calls).toEqual(["save recording", "save intent"]);
  });

  it("stays on the page when the take cannot be stored", async () => {
    signIn.saveRecording.mockRejectedValueOnce(new Error("QuotaExceededError"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<UploadLessonModal recording={recording} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    expect(await screen.findByText(/signing in now would lose it/i)).toBeTruthy();
    expect(signIn.saveResumeIntent).not.toHaveBeenCalled();
    expect(location.href).toBe("/code");
    error.mockRestore();
  });
});
