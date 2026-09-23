import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "@app/core/src";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
} from "../../lessons/metadataLimits";
import type { UploadedLesson, UploadLessonInput } from "./useUploadLesson";

const auth = vi.hoisted(() => ({ isSignedIn: false }));

const upload = vi.hoisted(() =>
  vi.fn<(args: { lessonId: string; input: UploadLessonInput }) => Promise<UploadedLesson>>(),
);

const signIn = vi.hoisted(() => ({
  calls: [] as string[],
  saveRecording: vi.fn<(recording: Recording) => Promise<void>>(),
  saveResumeIntent: vi.fn<(intent: unknown) => Promise<void>>(),
}));

vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({ isSignedIn: auth.isSignedIn, isLoading: false }),
  signInUrl: (returnTo: string) => `/api/auth/google/login?returnTo=${returnTo}`,
}));

vi.mock("./useUploadLesson", () => ({
  useUploadLesson: () => ({
    upload,
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

describe("UploadLessonModal text limits", () => {
  beforeEach(() => {
    auth.isSignedIn = true;
    upload.mockReset().mockResolvedValue({ id: "l1", slug: "s" });
  });

  afterEach(() => {
    auth.isSignedIn = false;
  });

  const clickUpload = () => fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));
  const typeTags = (value: string) =>
    fireEvent.change(screen.getByLabelText(/^Tags/), { target: { value } });

  it("caps typed titles and descriptions at the Worker's limits", () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    expect(screen.getByLabelText<HTMLInputElement>(/^Title/).maxLength).toBe(MAX_TITLE_CHARS);
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^Description/).maxLength).toBe(
      MAX_DESCRIPTION_CHARS,
    );
  });

  // maxLength only stops typing: a studio plan title or a draft restored after
  // sign-in arrives already longer, and would otherwise upload the whole
  // recording before the Worker refuses the POST.
  it("refuses a pre-filled title over the limit before uploading anything", async () => {
    render(
      <UploadLessonModal
        recording={recording}
        onClose={() => {}}
        initialTitle={"x".repeat(MAX_TITLE_CHARS + 1)}
      />,
    );

    clickUpload();

    expect(await screen.findByText("title must be at most 200 characters")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a tag longer than the Worker accepts before uploading anything", async () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    typeTags(`intro, ${"x".repeat(MAX_TAG_CHARS + 1)}`);
    clickUpload();

    expect(await screen.findByText("each tag must be at most 50 characters")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses more tags than the Worker accepts", async () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    typeTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`).join(", "));
    clickUpload();

    expect(await screen.findByText("at most 30 tags")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads tags at the limits", async () => {
    const tags = Array.from({ length: MAX_TAGS }, (_, i) => String(i).padEnd(MAX_TAG_CHARS, "x"));
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    typeTags(tags.join(", "));
    clickUpload();

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0].input.tags).toEqual(tags);
  });

  it("clears the limit message when the field is edited", async () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    typeTags(`intro, ${"x".repeat(MAX_TAG_CHARS + 1)}`);
    clickUpload();
    expect(await screen.findByText("each tag must be at most 50 characters")).toBeTruthy();

    typeTags("intro");

    expect(screen.queryByText("each tag must be at most 50 characters")).toBeNull();
  });
});
