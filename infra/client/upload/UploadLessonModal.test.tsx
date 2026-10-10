import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "@app/core/src";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
} from "../../lessons/metadataLimits";
import type * as UploadLessonModule from "./uploadLesson";
import type { UploadedLesson, UploadLessonInput } from "./useUploadLesson";

const auth = vi.hoisted(() => ({ isSignedIn: false }));

const upload = vi.hoisted(() =>
  vi.fn<(args: { lessonId: string; input: UploadLessonInput }) => Promise<UploadedLesson>>(),
);

// "Publish now" goes through My Library's publish mutation, which calls this.
const publishLesson = vi.hoisted(() => vi.fn<(lessonId: string) => Promise<void>>());

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
  formatDuration: () => "0:01",
}));

vi.mock("./uploadLesson", async (importOriginal) => ({
  ...(await importOriginal<typeof UploadLessonModule>()),
  publishLesson: (lessonId: string) => publishLesson(lessonId),
}));

vi.mock("@app/storage/RecordingStorage", () => ({
  getRecordingStorage: () => ({ save: signIn.saveRecording }),
}));

vi.mock("./resumeIntent", () => ({ saveResumeIntent: signIn.saveResumeIntent }));

const { default: UploadLessonModal } = await import("./UploadLessonModal");

// The publish mutation reads the query client from context.
function render(ui: ReactElement) {
  return renderUi(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

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

  // The message appears after an async action the user started, so it has to
  // be announced, not just painted.
  it("announces a limit error as an alert", async () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    typeTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`).join(", "));
    clickUpload();

    expect((await screen.findByRole("alert")).textContent).toBe("at most 30 tags");
  });

  it("announces a missing title and ties it to the title field", async () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);
    const titleInput = screen.getByLabelText<HTMLInputElement>(/^Title/);
    expect(titleInput.getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(titleInput, { target: { value: "   " } });
    clickUpload();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Title is required");
    expect(titleInput.getAttribute("aria-invalid")).toBe("true");
    expect(titleInput.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(titleInput);
    expect(upload).not.toHaveBeenCalled();
  });

  // One region mounted with the form: text changing inside a live region is
  // announced, a region mounted already holding its text often is not.
  it("mounts an empty upload status region with the form", () => {
    render(<UploadLessonModal recording={recording} onClose={() => {}} />);

    expect(screen.getByRole("status").textContent).toBe("");
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

describe("UploadLessonModal publish", () => {
  beforeEach(() => {
    auth.isSignedIn = true;
    upload.mockReset().mockResolvedValue({ id: "l1", slug: "s" });
    publishLesson.mockReset();
  });

  afterEach(() => {
    auth.isSignedIn = false;
  });

  async function uploadDraft(onClose: () => void) {
    render(<UploadLessonModal recording={recording} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));
    await screen.findByRole("heading", { name: "Saved as a draft" });
  }

  it("closes once the draft is published", async () => {
    publishLesson.mockResolvedValue();
    const onClose = vi.fn<() => void>();
    await uploadDraft(onClose);

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(publishLesson).toHaveBeenCalledWith("l1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so and stays open when publishing fails", async () => {
    publishLesson.mockRejectedValue(new Error("Request failed with status code 500"));
    const onClose = vi.fn<() => void>();
    await uploadDraft(onClose);

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't publish — try again.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Publish now" }).disabled).toBe(
      false,
    );
  });
});
