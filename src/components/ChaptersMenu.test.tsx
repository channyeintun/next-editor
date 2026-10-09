import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ChaptersMenu, { linkToMoment } from "./ChaptersMenu";
import type { Recording, RecordingChapter } from "../core/src";

const actions = vi.hoisted(() => ({
  seekTo: vi.fn<(time: number) => void>(),
  setChapters: vi.fn<(recordingId: string, chapters: RecordingChapter[]) => void>(),
}));
const clipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn<(text: string) => void>(),
}));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => actions,
  useLiveTimeValue: <T,>(derive: (currentTime: number) => T) => derive(65_000),
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
  window.history.replaceState(null, "", "/learn/router-basics?embed=true");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChaptersMenu", () => {
  it("jumps to a chapter and copies a link that opens the lesson there", () => {
    render(<ChaptersMenu recording={lesson} editable={false} iconSize={16} buttonClassName="" />);
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: "Routing" }));
    expect(actions.seekTo).toHaveBeenCalledWith(60_000);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Copy a link to Routing" }));
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/learn/router-basics?t=60`,
    );
    // Said, not only shown by the check mark.
    expect(screen.getByRole("status")).toHaveTextContent("Link copied");
    // Only the author can change them.
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /Add a chapter at 1:05/ }));
    expect(actions.setChapters).toHaveBeenLastCalledWith("lesson", [
      { time: 0, title: "Setup" },
      { time: 60_000, title: "Routing" },
      { time: 65_000, title: "Chapter 3" },
    ]);
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
