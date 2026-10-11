import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChaptersMenu, { CurrentChapterTitle, linkToMoment } from "./ChaptersMenu";
import type { Recording, RecordingChapter } from "../core/src";

const actions = vi.hoisted(() => ({
  seekTo: vi.fn<(time: number) => void>(),
  setChapters: vi.fn<(recordingId: string, chapters: RecordingChapter[]) => void>(),
}));
const clipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn<(text: string) => Promise<boolean>>(() => Promise.resolve(true)),
}));

// The playhead, between whole seconds: the menu shows 1:05 but keeps the exact time.
const playhead = vi.hoisted(() => ({ time: 65_400 }));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => actions,
  useLiveTimeValue: <T,>(derive: (currentTime: number) => T) => derive(playhead.time),
}));
vi.mock("../contexts/NextEditorActorContext", () => ({
  NextEditorActorContext: {
    useActorRef: () => ({
      getSnapshot: () => ({ context: { timeline: { currentTime: playhead.time } } }),
    }),
  },
}));
vi.mock("../utils/clipboard", () => clipboard);

const lesson = {
  id: "lesson",
  duration: 600_000,
  chapters: [
    { time: 0, title: "Setup" },
    { time: 60_000, title: "Routing" },
  ],
} as unknown as Recording;

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Chapters" }));

beforeEach(() => {
  playhead.time = 65_400;
  window.history.replaceState(null, "", "/learn/router-basics?embed=true");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChaptersMenu", () => {
  it("jumps to a chapter and copies a link that opens the lesson there", async () => {
    render(<ChaptersMenu recording={lesson} editable={false} iconSize={16} buttonClassName="" />);
    openMenu();

    // The playhead is at 1:05, in "Routing": that chapter is the current one.
    expect(screen.getByRole("button", { name: "Routing" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "1:00" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Setup" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "0:00" })).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: "Routing" }));
    expect(actions.seekTo).toHaveBeenCalledWith(60_000);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Copy a link to Routing" }));
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/learn/router-basics?t=60`,
    );
    // Said, not only shown by the check mark.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Link copied"));
    // Only the author can change them.
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("does not say the link was copied when the copy failed", async () => {
    clipboard.copyTextToClipboard.mockResolvedValueOnce(false);
    render(<ChaptersMenu recording={lesson} editable={false} iconSize={16} buttonClassName="" />);
    openMenu();

    // act waits for the click's copy to settle before the status region is read.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy a link to Routing" }));
    });

    expect(clipboard.copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Copy a link to Routing" })).toBeInTheDocument();
  });

  it("lets the author rename, delete, and add a chapter at the playhead", () => {
    render(<ChaptersMenu recording={lesson} editable iconSize={16} buttonClassName="" />);
    openMenu();

    const title = screen.getByLabelText("Title of the chapter at 1:00");
    fireEvent.change(title, { target: { value: "Routes and links" } });
    fireEvent.blur(title);
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", [
      { time: 0, title: "Setup" },
      { time: 60_000, title: "Routes and links" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Delete Setup" }));
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", [
      { time: 60_000, title: "Routing" },
    ]);
    // Focus stays in the panel, on the next row, not on the page's start.
    expect(screen.getByRole("button", { name: "Delete Routing" })).toHaveFocus();

    // Labelled by the whole second, stored at the exact playhead.
    fireEvent.click(screen.getByRole("button", { name: "Add a chapter at 1:05" }));
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", [
      { time: 0, title: "Setup" },
      { time: 60_000, title: "Routing" },
      { time: 65_400, title: "Chapter 3" },
    ]);
  });

  it("leaves Enter in a chapter title to an input method that is composing it", () => {
    render(<ChaptersMenu recording={lesson} editable iconSize={16} buttonClassName="" />);
    openMenu();

    const title = screen.getByLabelText("Title of the chapter at 1:00");
    title.focus();
    fireEvent.change(title, { target: { value: "ルーティング" } });

    // The Enter that picks a candidate belongs to the input method, not the field.
    fireEvent.keyDown(title, { key: "Enter", isComposing: true });
    // Safari's key that ends a composition comes after compositionend.
    fireEvent.keyDown(title, { key: "Enter", keyCode: 229 });
    expect(title).toHaveFocus();
    expect(actions.setChapters).not.toHaveBeenCalled();

    fireEvent.keyDown(title, { key: "Enter" });
    expect(title).not.toHaveFocus();
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", [
      { time: 0, title: "Setup" },
      { time: 60_000, title: "ルーティング" },
    ]);
  });

  it("keeps a chapter's title when the author adds one at the moment it starts", () => {
    // Paused on a chapter's start, as clicking its time or opening the lesson at 0:00 leaves it.
    playhead.time = 0;
    const intro = { ...lesson, chapters: [{ time: 0, title: "Intro" }] } as Recording;
    render(<ChaptersMenu recording={intro} editable iconSize={16} buttonClassName="" />);
    openMenu();

    // A second chapter there would replace "Intro": the press goes to its title instead.
    fireEvent.click(screen.getByRole("button", { name: "Add a chapter at 0:00" }));
    expect(actions.setChapters).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Title of the chapter at 0:00")).toHaveFocus();
  });

  it("copies a link to the playhead's second and keeps its check mark through that second", async () => {
    const { rerender } = render(
      <ChaptersMenu recording={lesson} editable={false} iconSize={16} buttonClassName="" />,
    );
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: "Copy a link to 1:05" }));
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/learn/router-basics?t=65`,
    );
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Link copied"));

    // Playback moves on within the same second: the link is the same, so the check stays.
    playhead.time = 65_900;
    rerender(<ChaptersMenu recording={lesson} editable={false} iconSize={16} buttonClassName="" />);
    const copyCurrent = screen.getByRole("button", { name: "Copy a link to 1:05" });
    expect(copyCurrent.querySelector(".lucide-check")).not.toBeNull();
  });

  it("moves focus to Add when the author deletes the last chapter", () => {
    const oneChapter = { ...lesson, chapters: [{ time: 0, title: "Setup" }] } as Recording;
    const { rerender } = render(
      <ChaptersMenu recording={oneChapter} editable iconSize={16} buttonClassName="" />,
    );
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: "Delete Setup" }));
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", []);
    rerender(
      <ChaptersMenu
        recording={{ ...oneChapter, chapters: [] }}
        editable
        iconSize={16}
        buttonClassName=""
      />,
    );
    expect(screen.getByRole("button", { name: /Add a chapter at/ })).toHaveFocus();
  });

  it("names a chapter by its place when the author clears its title", () => {
    render(<ChaptersMenu recording={lesson} editable iconSize={16} buttonClassName="" />);
    openMenu();

    const title = screen.getByLabelText("Title of the chapter at 1:00");
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.blur(title);
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", [
      { time: 0, title: "Setup" },
      { time: 60_000, title: "Chapter 2" },
    ]);
  });

  it("is a disclosure of a labelled group that Escape closes back to its button", () => {
    render(<ChaptersMenu recording={lesson} editable iconSize={16} buttonClassName="" />);
    const trigger = screen.getByRole("button", { name: "Chapters" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    openMenu();

    // Not a menu: it holds a text field and plain buttons, which Tab moves through.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    const panel = screen.getByRole("group", { name: "Chapters" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", panel.id);

    const title = screen.getByLabelText("Title of the chapter at 1:00");
    title.focus();
    expect(fireEvent.keyDown(title, { key: "Escape", isComposing: true })).toBe(true);
    // Safari's key that ends a composition comes after compositionend.
    expect(fireEvent.keyDown(title, { key: "Escape", keyCode: 229 })).toBe(true);
    expect(screen.getByRole("group", { name: "Chapters" })).toBeInTheDocument();

    expect(fireEvent.keyDown(title, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("group", { name: "Chapters" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
  });

  it("stays out of the way of a lesson with no chapters for its viewers", () => {
    const { container } = render(
      <ChaptersMenu
        recording={{ ...lesson, chapters: undefined }}
        editable={false}
        iconSize={16}
        buttonClassName=""
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("linkToMoment", () => {
  it("keeps the page's own parameters and drops the embed flag", () => {
    window.history.replaceState(null, "", "/code?url=%2Flesson.ne&embed=true&t=5");
    expect(linkToMoment(95_500)).toBe(`${window.location.origin}/code?url=%2Flesson.ne&t=95`);
  });
});

describe("CurrentChapterTitle", () => {
  const chapters = [
    { time: 5_000, title: "Setup" },
    { time: 60_000, title: "A much longer chapter title about routing" },
  ];

  // The progress bar beside it takes the row's free width, so a title sized
  // to its text would resize the bar, and move every control after it, at
  // each chapter boundary. jsdom has no layout: the classes are the contract.
  it("keeps one fixed-width box for the whole lesson, before the first chapter too", () => {
    const boxAt = (time: number) => {
      playhead.time = time;
      const { container, unmount } = render(<CurrentChapterTitle chapters={chapters} />);
      const box = container.firstElementChild;
      const result = { className: box?.className, text: box?.textContent };
      unmount();
      return result;
    };

    const before = boxAt(1_000);
    const first = boxAt(10_000);
    const second = boxAt(65_400);

    expect(before.text).toBe("");
    expect(first.text).toBe("Setup");
    expect(second.text).toBe("A much longer chapter title about routing");
    expect(first.className).toMatch(/(^|\s)w-48(\s|$)/);
    expect(first.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(before.className).toBe(first.className);
    expect(second.className).toBe(first.className);
  });
});
