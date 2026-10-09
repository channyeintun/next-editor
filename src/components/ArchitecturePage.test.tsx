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
});
