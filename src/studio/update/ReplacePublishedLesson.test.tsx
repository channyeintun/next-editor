import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../../core/src";
import type { StudioRunArtifacts } from "../runStudioRender";
import type { StudioAutomationLessonChange } from "../studioWindowHandle";
import { findPublishedLesson, replacePublishedLesson } from "./publishedLessonUpdate";
import { ReplacePublishedLesson } from "./ReplacePublishedLesson";

vi.mock("./publishedLessonUpdate", () => ({
  findPublishedLesson: vi.fn<typeof findPublishedLesson>(),
  replacePublishedLesson: vi.fn<typeof replacePublishedLesson>(),
}));

const mockedFind = vi.mocked(findPublishedLesson);
const mockedReplace = vi.mocked(replacePublishedLesson);

const artifacts: StudioRunArtifacts = {
  neBlob: new Blob([]),
  audioBlob: new Blob([]),
  audioFileName: "lesson-go-error-values.ogg",
  recording: { id: "run", duration: 65_000 } as Recording,
};

const change: StudioAutomationLessonChange = {
  lessonId: "lesson-1",
  urlSlug: "go-error-values",
  changedCues: 1,
  totalCues: 12,
  examples: ['"Return them." → "Return them now."'],
  publishedDurationMs: 60_000,
  newDurationMs: 65_000,
};

function renderButton() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ReplacePublishedLesson title="Go error values" artifacts={artifacts} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedFind.mockReset();
  mockedReplace.mockReset();
  mockedFind.mockResolvedValue({
    found: {
      lessonId: "lesson-1",
      urlSlug: "go-error-values",
      title: "Go error values",
      status: "published",
      duration: "1:00",
    },
  });
});

describe("ReplacePublishedLesson", () => {
  it("compares on the first click and replaces only on the second", async () => {
    const user = userEvent.setup();
    mockedReplace.mockImplementation((input) =>
      Promise.resolve(
        input.replace
          ? {
              replaced: {
                ...change,
                audioFile: "lesson-1-0123abcd.ogg",
                removedAudioFile: "lesson-1.ogg",
              },
            }
          : { compared: change },
      ),
    );
    renderButton();

    await user.click(screen.getByRole("button", { name: "Replace published lesson…" }));

    expect(mockedFind).toHaveBeenCalledWith({ title: "Go error values" });
    expect(mockedReplace).toHaveBeenCalledTimes(1);
    expect(mockedReplace.mock.calls[0][0]).toMatchObject({ lessonId: "lesson-1", replace: false });
    expect(await screen.findByText("1 of 12 caption cues differ.", { exact: false })).toBeTruthy();
    expect(screen.getByText('"Return them." → "Return them now."')).toBeTruthy();
    expect(screen.getByText("go-error-values")).toBeTruthy();
    expect(screen.getByText("(published)")).toBeTruthy();
    expect(screen.getByText(/1:00 now, 1:05/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Replace “Go error values”" }));

    expect(mockedReplace).toHaveBeenCalledTimes(2);
    expect(mockedReplace.mock.calls[1][0]).toMatchObject({ lessonId: "lesson-1", replace: true });
    expect(await screen.findByText("Replaced.")).toBeTruthy();
    expect(screen.getByText("lesson-1-0123abcd.ogg")).toBeTruthy();
    expect(screen.getByText("lesson-1.ogg")).toBeTruthy();
  });

  it("replaces nothing when the person cancels", async () => {
    const user = userEvent.setup();
    mockedReplace.mockResolvedValue({ compared: change });
    renderButton();

    await user.click(screen.getByRole("button", { name: "Replace published lesson…" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Replace “Go error values”" })).toBeNull();
    expect(mockedReplace).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal in its own words", async () => {
    const user = userEvent.setup();
    mockedFind.mockResolvedValue({
      refused: 'None of your 3 lessons is titled "Go error values".',
    });
    renderButton();

    await user.click(screen.getByRole("button", { name: "Replace published lesson…" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      'None of your 3 lessons is titled "Go error values".',
    );
    expect(mockedReplace).not.toHaveBeenCalled();
  });
});
