import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import LoadingSpinner from "./LoadingSpinner";

describe("LoadingSpinner", () => {
  it("is a status region whose text says it is loading", () => {
    render(<LoadingSpinner />);

    // Text content, not an aria-label: a status region announces its contents.
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-label");
  });

  it("announces a caller-supplied label", () => {
    render(<LoadingSpinner label="Loading lessons" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading lessons");
  });

  it("is decorative when the label is null", () => {
    const { container } = render(<LoadingSpinner label={null} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });
});
