import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { Slide } from "../types/slides";
import SlidesManager from "./SlidesManager";

function slide(id: string, order: number): Slide {
  return { id, content: `# ${id}`, contentType: "markdown", order };
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
});
