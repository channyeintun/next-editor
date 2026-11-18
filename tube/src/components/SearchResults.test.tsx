import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SearchResults as SearchResultsData } from "@next-editor/infra";
import type { MoreLessons } from "./SearchResults";

vi.mock("@next-editor/infra", () => ({
  avatarProxyUrl: (url: string) => url,
}));
vi.mock("./LessonCard", () => ({
  default: ({ lesson }: { lesson: { slug: string; title: string } }) => (
    <h3>
      <a href={`/learn/${lesson.slug}`}>{lesson.title}</a>
    </h3>
  ),
}));

const { default: SearchResults } = await import("./SearchResults");

const author = { username: "chan", name: "Chan Nyein Tun", avatarUrl: null };
const lesson = (slug: string, title: string) => ({ slug, title });

const playlist = {
  slug: "css-course",
  title: "CSS Course",
  description: "",
  lessonCount: 43,
  thumbnail: null,
};

function results(
  overrides: Partial<Record<"authors" | "playlists" | "lessons", unknown[]>> & {
    lessonTotal?: number;
  },
): SearchResultsData {
  const lessons = overrides.lessons ?? [];
  return {
    authors: [],
    playlists: [],
    lessonTotal: lessons.length,
    pageCount: 1,
    ...overrides,
    lessons,
  } as unknown as SearchResultsData;
}

const noMore: MoreLessons = { hasMore: false, isLoading: false, isError: false, load: () => {} };

function ui({
  data,
  isError = false,
  isBusy = false,
  onRetry = vi.fn<() => void>(),
  more = noMore,
}: {
  data: SearchResultsData | undefined;
  isError?: boolean;
  isBusy?: boolean;
  onRetry?: () => void;
  more?: MoreLessons;
}) {
  return (
    <MemoryRouter>
      <SearchResults data={data} isError={isError} isBusy={isBusy} onRetry={onRetry} more={more} />
    </MemoryRouter>
  );
}

describe("SearchResults", () => {
  it("names an author link by the author alone, not the decorative avatar initial", () => {
    render(ui({ data: results({ authors: [author] }) }));

    expect(screen.getByRole("link", { name: "Chan Nyein Tun" })).toHaveAttribute(
      "href",
      "/learn/@chan",
    );
  });

  // The page is lang="en"; a Burmese name must switch the screen reader's voice.
  it("marks the Burmese part of an author's name as lang=my", () => {
    render(ui({ data: results({ authors: [{ ...author, name: "Chan ချမ်း" }] }) }));

    const link = screen.getByRole("link", { name: "Chan ချမ်း" });
    const burmese = link.querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("ချမ်း");
  });

  it("heads the matching lessons with their own section, not the Authors one", () => {
    render(
      ui({
        data: results({ authors: [author], lessons: [lesson("closures", "Closures in Rust")] }),
      }),
    );

    const headings = screen.getAllByRole("heading");
    expect(headings.map((h) => [h.tagName, h.textContent])).toEqual([
      ["H2", "Authors"],
      ["H2", "Lessons"],
      ["H3", "Closures in Rust"],
    ]);
  });

  it("lists matching playlists after authors and before lessons, linking to the playlist", () => {
    render(
      ui({
        data: results({
          authors: [author],
          playlists: [playlist],
          lessons: [lesson("css-12", "CSS Course 12")],
        }),
      }),
    );

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Authors", "Playlists", "Lessons"]);
    expect(screen.getByRole("link", { name: "CSS Course, 43 lessons" })).toHaveAttribute(
      "href",
      "/learn/playlist/css-course",
    );
  });

  it("has no Lessons heading when only authors match", () => {
    render(ui({ data: results({ authors: [author] }) }));

    expect(screen.queryByRole("heading", { name: "Lessons" })).not.toBeInTheDocument();
  });

  it("keeps the last results on screen, dimmed, busy and inert, while a newer search loads", () => {
    render(
      ui({ data: results({ lessons: [lesson("closures", "Closures in Rust")] }), isBusy: true }),
    );

    const wrapper = screen
      .getByRole("heading", { name: "Closures in Rust" })
      .closest("[aria-busy]");
    expect(wrapper).toHaveAttribute("aria-busy", "true");
    expect(wrapper).toHaveAttribute("inert");
    expect(wrapper).toHaveClass("opacity-50");
  });

  it("dims a previous 'no match' too, instead of presenting it as the new answer", () => {
    render(ui({ data: results({}), isBusy: true }));

    const message = screen.getByText("No authors, playlists or lessons match your search.");
    expect(message.closest("[aria-busy]")).toHaveClass("opacity-50");
  });

  it("brings an answer in from the dimmed level as a whole, not card by card", () => {
    render(ui({ data: results({ lessons: [lesson("closures", "Closures in Rust")] }) }));

    const card = screen.getByRole("heading", { name: "Closures in Rust" });
    const wrapper = card.closest("[aria-busy]");
    expect(wrapper).toHaveClass("starting:opacity-50");
    // Only the wrapper fades: a card fading too would start at 50% of 50%.
    expect(wrapper?.querySelectorAll("[class*='starting:']")).toHaveLength(0);
  });

  it("shows the failure with a retry, and nothing before the first answer", () => {
    const onRetry = vi.fn<() => void>();
    const view = render(ui({ data: undefined, isError: true, onRetry }));
    expect(screen.getByRole("alert")).toHaveTextContent("Search failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    view.rerender(ui({ data: undefined }));
    expect(view.container).toBeEmptyDOMElement();
  });

  describe("Show more lessons", () => {
    const firstPage = [lesson("css-43", "CSS Course 43"), lesson("css-42", "CSS Course 42")];

    it("says how many lessons are shown, and loads more when pressed", () => {
      const load = vi.fn<() => void>();
      render(
        ui({
          data: results({ lessons: firstPage, lessonTotal: 43 }),
          more: { ...noMore, hasMore: true, load },
        }),
      );

      expect(screen.getByText("Showing 2 of 43 lessons")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show more lessons" }));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("is absent once every matching lesson is shown", () => {
      render(ui({ data: results({ lessons: firstPage }) }));

      expect(screen.queryByRole("button", { name: "Show more lessons" })).not.toBeInTheDocument();
    });

    it("keeps focus while loading, without loading twice", () => {
      const load = vi.fn<() => void>();
      render(
        ui({
          data: results({ lessons: firstPage, lessonTotal: 43 }),
          more: { ...noMore, hasMore: true, isLoading: true, load },
        }),
      );

      const button = screen.getByRole("button", { name: "Show more lessons" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(load).not.toHaveBeenCalled();
    });

    it("moves focus to the first lesson it added", () => {
      const more = { ...noMore, hasMore: true };
      const view = render(ui({ data: results({ lessons: firstPage, lessonTotal: 43 }), more }));
      fireEvent.click(screen.getByRole("button", { name: "Show more lessons" }));

      view.rerender(
        ui({
          data: results({
            lessons: [...firstPage, lesson("css-41", "CSS Course 41")],
            lessonTotal: 43,
          }),
          more,
        }),
      );

      expect(screen.getByRole("link", { name: "CSS Course 41" })).toHaveFocus();
    });

    it("keeps the lessons shown when loading more fails, with the reason", () => {
      render(
        ui({
          data: results({ lessons: firstPage, lessonTotal: 43 }),
          more: { ...noMore, hasMore: true, isError: true },
        }),
      );

      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load more lessons.");
      expect(screen.getByRole("heading", { name: "CSS Course 43" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show more lessons" })).toBeInTheDocument();
    });
  });
});
