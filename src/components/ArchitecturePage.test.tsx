import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import ArchitecturePage from "./ArchitecturePage";

describe("ArchitecturePage", () => {
  // The diagram overflows sideways on narrow screens, and Safari does not
  // focus scroll containers on its own: the wrapper must take keyboard focus.
  it("puts the diagram in a named, focusable scroll region", () => {
    render(<ArchitecturePage />);
    const region = screen.getByRole("region", { name: "System architecture diagram" });

    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("img", { name: /Layered architecture/ })).toBeInTheDocument();
  });

  it("exposes the legend and the numbered notes as lists", () => {
    render(<ArchitecturePage />);
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
});
