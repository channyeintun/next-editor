import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import ArchitecturePage from "./ArchitecturePage";

// The sheet links to the other sheets, so it renders inside a router.
function renderPage() {
  return render(
    <MemoryRouter>
      <ArchitecturePage />
    </MemoryRouter>,
  );
}

describe("ArchitecturePage", () => {
  it("is the first sheet of the set and links to the webnode sheet", () => {
    renderPage();
    const sheets = screen.getByRole("navigation", { name: "Architecture sheets" });

    expect(within(sheets).getByText("01 system architecture")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(sheets).getByRole("link", { name: "02 webnode runtime" })).toHaveAttribute(
      "href",
      "/architecture/webnode",
    );
    // The title block counts the sheets the navigation lists.
    expect(screen.getByText("01 / 02")).toBeInTheDocument();
  });

  // The diagram overflows sideways on narrow screens, and Safari does not
  // focus scroll containers on its own: the wrapper must take keyboard focus.
  it("puts the diagram in a named, focusable scroll region", () => {
    renderPage();
    const region = screen.getByRole("region", { name: "System architecture diagram" });

    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("img", { name: /Layered architecture/ })).toBeInTheDocument();
  });

  it("exposes the legend and the numbered notes as lists", () => {
    renderPage();
    const [legend, notes] = screen.getAllByRole("list");

    const legendItems = within(legend).getAllByRole("listitem");
    expect(legendItems).toHaveLength(5);
    expect(legendItems[1]).toHaveTextContent("external service");
    // The swatches are pictures of the key; only their labels are read.
    expect(within(legend).getByText("#")).toHaveAttribute("aria-hidden", "true");
    expect(legendItems[4]).toHaveTextContent("see note");

    expect(notes.tagName).toBe("OL");
    const noteItems = within(notes).getAllByRole("listitem");
    expect(noteItems).toHaveLength(41);
    expect(within(noteItems[0]).getByText("01")).toBeInTheDocument();
    expect(within(noteItems[40]).getByText("41")).toBeInTheDocument();
  });

  it("names the build table and marks each label as its row header", () => {
    renderPage();
    const table = screen.getByRole("table", { name: "Build & tooling" });

    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders).toHaveLength(12);
    expect(rowHeaders[0]).toHaveAccessibleName("package manager");
    expect(rowHeaders[0]).toHaveAttribute("scope", "row");
    expect(rowHeaders[11]).toHaveAccessibleName("deploy");
    expect(within(table).queryAllByRole("columnheader")).toHaveLength(0);
  });

  it("numbers the diagram's tags and the notes 1 to 41 in the same order", () => {
    const { container } = renderPage();
    const expected = Array.from({ length: 41 }, (_, index) => index + 1);

    // Each chip and service box draws its tag as the text after its circle.
    const tags = [...container.querySelectorAll("svg circle + text")].map((tag) =>
      Number(tag.textContent),
    );
    expect(tags).toEqual(expected);

    const [, notes] = screen.getAllByRole("list");
    const noteItems = within(notes).getAllByRole("listitem");
    expect(noteItems.map((item) => Number(item.querySelector(".n")?.textContent))).toEqual(
      expected,
    );
    for (const item of noteItems) {
      expect(item.querySelector("b")?.textContent).toMatch(/\S —$/);
      expect(item.querySelector(".d")?.textContent).not.toBe("");
    }
    expect(noteItems[2].textContent).toMatch(/^03xstate \+ store-react — the recorder\/player/);
    expect(noteItems[26].textContent).toMatch(/^27Workers KV — playground Run\/Format results/);
  });

  it("describes Workers KV as the playground result cache only", () => {
    renderPage();
    const table = screen.getByRole("table", { name: "Build & tooling" });
    const row = within(table).getByRole("rowheader", { name: "public cache" }).closest("tr");

    expect(row).toHaveTextContent("workers kv — fail-open playground Run/Format result cache");
    expect(row?.textContent).not.toMatch(/lesson|playlist/);
  });
});
