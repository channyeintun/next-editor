import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Slide } from "../types/slides";
import SlidesManager from "./SlidesManager";

function slide(id: string, order: number): Slide {
  return { id, content: `# ${id}`, contentType: "markdown", order };
}

function renderManager(slides: Slide[]) {
  const emitted: Slide[][] = [];
  render(
    <SlidesManager
      slides={slides}
      onSlidesChange={(next) => {
        emitted.push(next);
      }}
      onStartPresentation={() => {}}
      onClose={() => {}}
    />,
  );
  return emitted;
}

/** A slide row's thumbnail opens its editor; its corner label names the slide's type. */
function clickThumbnail(typeLabel: string) {
  fireEvent.click(screen.getByText(typeLabel));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlidesManager", () => {
  // The deck it is handed can be the very array a finished take or a loaded
  // lesson holds (NextEditorProvider's getSlides/applySlides share it), so a
  // reorder must build new slides rather than renumber those in place.
  it("reorders without writing into the slides it was given", () => {
    const a = slide("a", 0);
    const b = slide("b", 1);
    const given = [a, b];
    let emitted: Slide[] | null = null;

    render(
      <SlidesManager
        slides={given}
        onSlidesChange={(slides) => {
          emitted = slides;
        }}
        onStartPresentation={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByTitle("Move Down")[0]);

    expect(a).toEqual(slide("a", 0));
    expect(b).toEqual(slide("b", 1));
    expect(emitted).toEqual([slide("b", 0), slide("a", 1)]);
  });

  it("creates a slide from the chosen type, trimmed text and background", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const emitted = renderManager([slide("a", 0)]);

    fireEvent.click(screen.getByText("HTML"));
    fireEvent.change(screen.getByPlaceholderText(/<h1>Title<\/h1>/), {
      target: { value: "  <p>Hi</p>  " },
    });
    fireEvent.click(screen.getByLabelText("Texture 2"));
    fireEvent.click(screen.getByText("Create Slide"));

    const created = emitted[0].at(-1)!;
    expect(emitted).toEqual([[slide("a", 0), created]]);
    // Key order is kept: decks are saved as JSON.
    expect(JSON.stringify(created)).toBe(
      '{"id":"1700000000000","content":"<p>Hi</p>","contentType":"html","order":1,"background":"texture-2"}',
    );
    // The text and background clear for the next slide; the type stays.
    expect(screen.getByPlaceholderText(/<h1>Title<\/h1>/)).toHaveValue("");
    expect(screen.getByLabelText("No background")).toHaveAttribute("aria-pressed", "true");
  });

  it("gives an empty new slide its type's starter content", () => {
    const emitted = renderManager([]);

    fireEvent.click(screen.getByText("Create Slide"));
    fireEvent.click(screen.getByText("HTML"));
    fireEvent.click(screen.getByText("Create Slide"));

    expect(
      emitted.map((deck) => deck.map(({ content, contentType }) => ({ content, contentType }))),
    ).toEqual([
      [{ content: "# Welcome\n\nYour slide content here", contentType: "markdown" }],
      [{ content: "<h1>Welcome</h1>\n<p>Your slide content here</p>", contentType: "html" }],
    ]);
  });

  it("edits a slide's text and background in place", () => {
    const html: Slide = { id: "h", content: "<p>Old</p>", contentType: "html", order: 1 };
    const emitted = renderManager([slide("a", 0), html]);

    clickThumbnail("html");
    const editor = screen.getByDisplayValue("<p>Old</p>");
    fireEvent.change(editor, { target: { value: "<p>New</p>" } });
    // The edit form has the second background picker; the first is the new-slide form's.
    fireEvent.click(screen.getAllByLabelText("Texture 1")[1]);
    fireEvent.click(screen.getByText("Update"));

    expect(emitted).toEqual([
      [slide("a", 0), { ...html, content: "<p>New</p>", background: "texture-1" }],
    ]);
    expect(screen.queryByDisplayValue("<p>New</p>")).toBeNull();
  });

  it("drops the draft on cancel", () => {
    const emitted = renderManager([slide("a", 0)]);

    clickThumbnail("markdown");
    fireEvent.change(screen.getByDisplayValue("# a"), { target: { value: "# changed" } });
    fireEvent.click(screen.getByLabelText("Cancel editing slide"));

    expect(emitted).toEqual([]);
    expect(screen.queryByDisplayValue("# changed")).toBeNull();
    clickThumbnail("markdown");
    expect(screen.getByDisplayValue("# a")).toBeInTheDocument();
  });

  it("does not open an imported Google slide for editing", () => {
    renderManager([
      {
        id: "g",
        content: "<svg></svg>",
        contentType: "google-svg",
        order: 0,
        title: "Deck page",
      },
    ]);

    clickThumbnail("slides");

    expect(screen.queryByLabelText("Cancel editing slide")).toBeNull();
  });
});
