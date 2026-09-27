import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
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
