import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import WebnodeArchitecturePage from "./WebnodeArchitecturePage";
import { STEP_DWELL_MS } from "./webnodeArchitecture/FlowPlayer";
import { FLOWS } from "./webnodeArchitecture/flows";
import { PARTS } from "./webnodeArchitecture/parts";
import { stepTravelMs } from "./webnodeArchitecture/placement";

const [boot] = FLOWS;

function renderPage() {
  return render(
    <MemoryRouter>
      <WebnodeArchitecturePage />
    </MemoryRouter>,
  );
}

/** Answers `prefers-reduced-motion` as a browser set to `reduce` (or not) does. */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

/** Lets the time a step takes pass: its marks' travel, then its stay. */
function passStep(flowIndex: number, stepIndex: number) {
  act(() => {
    vi.advanceTimersByTime(stepTravelMs(flowIndex, stepIndex) + STEP_DWELL_MS);
  });
}

function marks(container: HTMLElement) {
  return [...container.querySelectorAll<SVGGElement>(".wn-mark")];
}

/** The text of a caption or a step as the page shows it: backticks are markup, not text. */
const shown = (text: string) => text.replaceAll("`", "");

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebnodeArchitecturePage", () => {
  it("is the second sheet of the set, titled, and links back to the system sheet", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "webnode — how it works" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("next-editor — webnode runtime");
    expect(screen.getByText("02 / 02")).toBeInTheDocument();

    const sheets = screen.getByRole("navigation", { name: "Architecture sheets" });
    expect(within(sheets).getByRole("link", { name: "01 system architecture" })).toHaveAttribute(
      "href",
      "/architecture",
    );
    expect(within(sheets).getByText("02 webnode runtime")).toHaveAttribute("aria-current", "page");
  });

  it("has one h1 and never skips a heading level", () => {
    renderPage();
    const levels = screen.getAllByRole("heading").map((heading) => Number(heading.tagName[1]));

    expect(levels[0]).toBe(1);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    // How far each heading goes down from the one before it: never past the next level.
    const steps = levels.slice(1).map((level, index) => level - levels[index]);
    expect(Math.max(...steps)).toBeLessThanOrEqual(1);
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Flows", "Parts", "Design notes", "Messages"]);
  });

  // The diagram overflows sideways on narrow screens, and Safari does not
  // focus scroll containers on its own: the wrapper must take keyboard focus.
  it("puts the diagram in a named, focusable scroll region", () => {
    renderPage();
    const region = screen.getByRole("region", { name: "webnode flow diagram" });

    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("img", { name: /parts of webnode/ })).toBeInTheDocument();
  });

  it("numbers the diagram's parts and the Parts notes in the same order", () => {
    const { container } = renderPage();
    const expected = PARTS.map((_, index) => index + 1);

    // Each part draws its tag as the text after its circle.
    const tags = [...container.querySelectorAll("svg.wn-diagram circle + text")].map((tag) =>
      Number(tag.textContent),
    );
    expect(tags).toEqual(expected);

    const parts = screen.getByRole("heading", { level: 2, name: "Parts" }).nextElementSibling!;
    expect(parts.tagName).toBe("OL");
    const notes = within(parts as HTMLElement).getAllByRole("listitem");
    expect(notes.map((note) => Number(note.querySelector(".n")?.textContent))).toEqual(expected);
    notes.forEach((note, index) => {
      const part = PARTS[index];
      expect(note.querySelector("b")?.textContent).toBe(`${part.noteTitle ?? part.title} —`);
      expect(note.querySelector(".src")?.textContent).toBe(part.source);
    });
  });

  it("plays a flow step by step, and Pause holds it where it is", () => {
    const { container } = renderPage();
    const diagram = container.querySelector("svg.wn-diagram")!;

    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    expect(diagram).toHaveAttribute("data-playing", "true");
    expect(marks(container).map((mark) => mark.style.animationName)).toEqual(["wn-boot-0-0"]);

    passStep(0, 0);
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
    expect(marks(container).map((mark) => mark.style.animationName)).toEqual(["wn-boot-1-0"]);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    // The mark keeps its animation, which the stylesheet holds while paused.
    expect(diagram).toHaveAttribute("data-playing", "false");
    expect(marks(container).map((mark) => mark.style.animationName)).toEqual(["wn-boot-1-0"]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(diagram).toHaveAttribute("data-playing", "true");
    passStep(0, 1);
    expect(screen.getByText("Step 3 of 5")).toBeInTheDocument();
  });

  it("starts again from the first step after the last", () => {
    renderPage();

    boot.steps.forEach((_, index) => passStep(0, index));

    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
  });

  it("shows a step without motion on Back and Next, stops playing, and announces the step", () => {
    const { container } = renderPage();
    const caption = container.querySelector(".flow-caption")!;
    // While it plays, a screen reader is not interrupted every few seconds.
    expect(caption).toHaveAttribute("aria-live", "off");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
    expect(caption).toHaveAttribute("aria-live", "polite");
    expect(caption).toHaveTextContent(shown(boot.steps[1].title));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(marks(container).map((mark) => mark.style.animationName)).toEqual([""]);

    // Back from the first step is the last one.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();

    // Play runs the step shown from its start.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(marks(container).map((mark) => mark.style.animationName)).toEqual(["wn-boot-4-0"]);
  });

  it("neither moves nor advances under reduced motion, and still draws the whole step", () => {
    stubReducedMotion(true);
    const { container } = renderPage();

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();

    // The step is drawn still: its line with an arrowhead, the message's name
    // on it, and the mark where the message arrives.
    const [mark] = marks(container);
    expect(mark.style.animationName).toBe("");
    expect(mark).toHaveAttribute("transform", "translate(364 148)");
    expect(container.querySelector(".wn-route")).toHaveAttribute(
      "marker-end",
      "url(#wn-arrow-request)",
    );
    expect(
      within(container.querySelector("svg.wn-diagram")!).getByText("boot"),
    ).toBeInTheDocument();

    // Play, asked for, changes the steps without any travel.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => {
      vi.advanceTimersByTime(STEP_DWELL_MS);
    });
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
    expect(marks(container).map((item) => item.style.animationName)).toEqual([""]);
  });

  it("stops the marks in the stylesheet too when the system asks for less motion", () => {
    const { container } = renderPage();
    const css = [...container.querySelectorAll("style")].map((style) => style.textContent).join("");

    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\{\s*\.arch-page \.wn-mark\{ animation:none !important; \}/,
    );
    expect(css).toContain(
      '.wn-diagram[data-playing="false"] .wn-mark{ animation-play-state:paused; }',
    );
    expect(css).toContain("@keyframes wn-boot-0-0{");
  });

  it("lists every step of the chosen flow as text, with the current one marked", () => {
    renderPage();

    FLOWS.forEach((flow, flowIndex) => {
      fireEvent.click(screen.getByRole("button", { name: flow.name }));

      const picker = screen.getByRole("group", { name: "Flow" });
      expect(
        within(picker)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-pressed")),
      ).toEqual(FLOWS.map((_, index) => String(index === flowIndex)));

      const steps = screen.getByRole("region", { name: `Steps: ${flow.name}` });
      const list = within(steps).getByRole("list");
      expect(list.tagName).toBe("OL");
      const items = within(list).getAllByRole("listitem");
      expect(items).toHaveLength(flow.steps.length);
      items.forEach((item, index) => {
        expect(item).toHaveTextContent(shown(flow.steps[index].title));
        expect(item).toHaveTextContent(shown(flow.steps[index].detail));
        expect(item.getAttribute("aria-current")).toBe(index === 0 ? "step" : null);
      });
    });
  });

  it("keys the message kinds by shape and by word, not by colour alone", () => {
    renderPage();
    const legend = screen.getAllByRole("list")[0];
    const items = within(legend).getAllByRole("listitem");

    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "request",
      "response",
      "event",
      "direct call",
      "part of webnode",
      "the network",
      "# see note",
    ]);
    const shapes = items.slice(0, 4).map((item) => {
      const svg = item.querySelector("svg")!;
      // The shapes are pictures of the key; only their words are read.
      expect(svg).toHaveAttribute("aria-hidden", "true");
      const shape = svg.firstElementChild!;
      return `${shape.tagName}:${shape.getAttribute("points") ?? ""}`;
    });
    expect(new Set(shapes).size).toBe(4);

    // The caption names the kind of the step's message in words as well.
    const caption = document.querySelector(".flow-caption")!;
    expect(within(caption as HTMLElement).getByText("request")).toBeInTheDocument();
  });

  it("names the messages table and marks each channel as its row header", () => {
    renderPage();
    const table = screen.getByRole("table", { name: "Messages" });

    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders).toHaveLength(9);
    expect(rowHeaders[0]).toHaveAccessibleName("editor → kernel");
    expect(rowHeaders[0]).toHaveAttribute("scope", "row");
    expect(within(table).queryAllByRole("columnheader")).toHaveLength(0);
    expect(within(table).getByText("webnode:preview-connect")).toBeInTheDocument();
  });
});
