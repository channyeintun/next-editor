import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SearchResults as SearchResultsData } from "@next-editor/infra";

vi.mock("@next-editor/infra", () => ({
  avatarProxyUrl: (url: string) => url,
}));
vi.mock("./LessonCard", () => ({
  default: ({ lesson }: { lesson: { title: string } }) => <h3>{lesson.title}</h3>,
}));

const { default: SearchResults } = await import("./SearchResults");

const author = { username: "chan", name: "Chan Nyein Tun", avatarUrl: null };
const lesson = (slug: string, title: string) => ({ slug, title });

function results(overrides: Partial<Record<"authors" | "lessons", unknown[]>>): SearchResultsData {
  return { authors: [], lessons: [], ...overrides } as unknown as SearchResultsData;
}

function ui({
  data,
  isError = false,
  isBusy = false,
  onRetry = vi.fn<() => void>(),
}: {
  data: SearchResultsData | undefined;
  isError?: boolean;
  isBusy?: boolean;
  onRetry?: () => void;
}) {
  return (
    <MemoryRouter>
      <SearchResults data={data} isError={isError} isBusy={isBusy} onRetry={onRetry} />
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

    const message = screen.getByText("No authors or lessons match your search.");
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
});
