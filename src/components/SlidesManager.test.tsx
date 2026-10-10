import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Slide } from "../types/slides";
import type { SlidesUpdate } from "../hooks/useSlidesController";
import type { ParsedDeck } from "../googleSlides/types";
import { fetchPublishedDeck } from "../googleSlides/fetchPublishedDeck";
import SlidesManager from "./SlidesManager";

// The real fetch (its link checks included), which a test can hold open to change the deck
// while an import waits.
vi.mock("../googleSlides/fetchPublishedDeck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../googleSlides/fetchPublishedDeck")>();
  return {
    ...actual,
    fetchPublishedDeck: vi.fn<typeof actual.fetchPublishedDeck>(actual.fetchPublishedDeck),
  };
});

function slide(id: string, order: number): Slide {
  return { id, content: `# ${id}`, contentType: "markdown", order };
}

/** The deck an update leaves, applied to `current` as the slides store applies it. */
const applyUpdate = (update: SlidesUpdate, current: Slide[]) =>
  typeof update === "function" ? update(current) : update;

function renderManager(slides: Slide[]) {
  const emitted: Slide[][] = [];
  render(
    <SlidesManager
      slides={slides}
      onSlidesChange={(update) => {
        emitted.push(applyUpdate(update, slides));
      }}
      onStartPresentation={() => {}}
      onClose={() => {}}
    />,
  );
  return emitted;
}

/** Like renderManager, but feeds each emitted deck back in, as the slides store does. */
function renderLiveManager(initial: Slide[]) {
  const emitted: Slide[][] = [];
  // The store's deck: an update applies to the latest one, not to a render's copy.
  let deck = initial;
  function LiveManager() {
    const [slides, setSlides] = useState(initial);
    return (
      <SlidesManager
        slides={slides}
        onSlidesChange={(update) => {
          deck = applyUpdate(update, deck);
          emitted.push(deck);
          setSlides(deck);
        }}
        onStartPresentation={() => {}}
        onClose={() => {}}
      />
    );
  }
  render(<LiveManager />);
  return emitted;
}

const LINK_HINT =
  "In Google Slides: File → Share → Publish to web, then paste the published link here.";

/** A slide row's thumbnail opens its editor; its corner label names the slide's type. */
function clickThumbnail(typeLabel: string) {
  fireEvent.click(screen.getByText(typeLabel));
}

afterEach(() => {
  vi.useRealTimers();
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
        onSlidesChange={(update) => {
          emitted = applyUpdate(update, given);
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
    expect(screen.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");
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

  it("exposes which slide type is selected", () => {
    renderManager([]);
    const types = screen.getByRole("group", { name: "Slide type" });
    const markdown = screen.getByRole("button", { name: "Markdown" });
    const html = screen.getByRole("button", { name: "HTML" });

    expect(types).toContainElement(markdown);
    expect(types).toContainElement(html);
    expect(markdown).toHaveAttribute("aria-pressed", "true");
    expect(html).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(html);

    expect(html).toHaveAttribute("aria-pressed", "true");
    expect(markdown).toHaveAttribute("aria-pressed", "false");
  });

  it("names the background picker's options by their visible text, under its caption", () => {
    renderManager([slide("a", 0)]);
    const picker = screen.getByRole("group", { name: "Background" });
    const none = screen.getByRole("button", { name: "None" });

    expect(picker).toContainElement(none);
    expect(picker).toContainElement(screen.getByRole("button", { name: "Texture 1" }));
    expect(none).toHaveAccessibleDescription("No background");
    expect(none).toHaveAttribute("aria-pressed", "true");

    // The slide editor has a second picker; the first is the new-slide form's.
    clickThumbnail("markdown");
    const pickers = screen.getAllByRole("group", { name: "Background" });
    expect(pickers).toHaveLength(2);
    expect(pickers[1]).toContainElement(screen.getAllByRole("button", { name: "None" })[1]);
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

  it("opens the editor from the thumbnail button and hands focus back when it closes", async () => {
    renderManager([slide("a", 0)]);
    const thumbnail = () => screen.getByRole("button", { name: "Edit markdown slide 1" });

    fireEvent.click(thumbnail());
    expect(screen.getByRole("textbox", { name: "Slide 1 content" })).toHaveFocus();
    fireEvent.click(screen.getByLabelText("Cancel editing slide"));
    await waitFor(() => expect(thumbnail()).toHaveFocus());

    fireEvent.click(thumbnail());
    expect(screen.getByRole("textbox", { name: "Slide 1 content" })).toHaveFocus();
    fireEvent.click(screen.getByText("Update"));
    await waitFor(() => expect(thumbnail()).toHaveFocus());
  });

  it("shows each slide type's icon, and the Markdown one for any other type", () => {
    const typed = (id: string, contentType: string) =>
      ({ id, content: id, contentType, order: 0 }) as unknown as Slide;
    renderManager([
      typed("google", "google-svg"),
      typed("html", "html"),
      typed("markdown", "markdown"),
      // A recording's deck is not checked on the way in.
      { id: "untyped", content: "untyped", order: 0 } as unknown as Slide,
      typed("inherited", "constructor"),
    ]);

    const icons = [
      ...document.querySelectorAll(
        '[class="absolute inset-0 flex items-center justify-center"] > svg',
      ),
    ].map((icon) => icon.getAttribute("class"));
    expect(icons).toEqual([
      "lucide lucide-presentation text-amber-300/70 size-4",
      "lucide lucide-code text-sky-300/60 size-4",
      "lucide lucide-file-text text-cyan-300/60 size-4",
      "lucide lucide-file-text text-cyan-300/60 size-4",
      "lucide lucide-file-text text-cyan-300/60 size-4",
    ]);
    // An untyped slide shows no corner label, so its thumbnail's name has no type either.
    expect(screen.getByRole("button", { name: "Edit slide 4" })).toBeInTheDocument();
  });

  it("labels the slide text fields", () => {
    renderManager([slide("a", 0)]);

    expect(screen.getByLabelText("Slide content")).toHaveAttribute(
      "placeholder",
      "# Title\n\nContent here...",
    );
    expect(
      screen.getByRole("textbox", { name: "Import from Google Slides" }),
    ).toHaveAccessibleDescription(LINK_HINT);
    clickThumbnail("markdown");
    expect(screen.getByRole("textbox", { name: "Slide 1 content" })).toHaveValue("# a");
  });

  it("announces a failed import and ties the message to the link field", async () => {
    renderManager([]);
    const link = screen.getByLabelText("Import from Google Slides");

    fireEvent.change(link, { target: { value: "https://example.com/deck" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^Enter a published Google Slides link/);
    expect(link).toHaveAttribute("aria-invalid", "true");
    expect(link).toHaveAccessibleDescription(`${LINK_HINT} ${alert.textContent}`);

    // Editing the link clears the error.
    fireEvent.change(link, { target: { value: "https://example.com/deck2" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(link).not.toHaveAttribute("aria-invalid");
    expect(link).toHaveAccessibleDescription(LINK_HINT);
  });

  it("imports a deck onto the slides as they are when it arrives, keeping edits made meanwhile", async () => {
    let deliver: (deck: ParsedDeck) => void = () => {};
    vi.mocked(fetchPublishedDeck).mockReturnValueOnce(
      new Promise((resolve) => {
        deliver = resolve;
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const emitted = renderLiveManager([slide("a", 0)]);
    const deckUrl = "https://docs.google.com/presentation/d/e/deck/pub";

    fireEvent.change(screen.getByLabelText("Import from Google Slides"), {
      target: { value: deckUrl },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(fetchPublishedDeck).toHaveBeenCalledWith(deckUrl);

    // A slide is created while the deck is still downloading.
    fireEvent.click(screen.getByText("Create Slide"));
    const created = emitted.at(-1)!.at(-1)!;
    expect(created.id).toBe("1700000000000");

    await act(async () => {
      deliver({
        sourceUrl: deckUrl,
        width: 16,
        height: 9,
        slides: [{ pageId: "p1", title: "Intro", svg: "<svg></svg>", steps: [] }],
      });
    });

    expect(emitted.at(-1)!.map((entry) => [entry.id, entry.order])).toEqual([
      ["a", 0],
      ["1700000000000", 1],
      ["p1", 2],
    ]);
  });

  it("keeps a failed upload's alert until the next background choice", async () => {
    vi.useFakeTimers();
    renderManager([]);
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Please choose an image file.");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Texture 1"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("undoes a slide deletion", () => {
    const given = [slide("a", 0), slide("b", 1)];
    const emitted = renderLiveManager(given);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(emitted).toEqual([[slide("b", 0)]]);
    expect(status).toHaveTextContent("1 slide removed");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(emitted.at(-1)).toBe(given);
    expect(status).toBeEmptyDOMElement();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
  });

  it("undoes removing an imported deck, bringing back its link", () => {
    const deckSlide = (id: string, order: number): Slide => ({
      id,
      content: "<svg></svg>",
      contentType: "google-svg",
      order,
      sourceUrl: "https://docs.google.com/presentation/d/e/x/pub",
    });
    const given = [deckSlide("g1", 0), slide("a", 1), deckSlide("g2", 2)];
    const emitted = renderLiveManager(given);

    fireEvent.click(screen.getByRole("button", { name: "Remove deck" }));

    expect(emitted).toEqual([[slide("a", 0)]]);
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("2 slides removed");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(emitted.at(-1)).toBe(given);
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("stops offering Undo once the deck changes again", () => {
    renderLiveManager([slide("a", 0), slide("b", 1)]);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Create Slide"));

    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
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
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  });
});
