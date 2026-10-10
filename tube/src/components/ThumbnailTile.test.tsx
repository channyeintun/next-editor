import { fireEvent, render, screen } from "@testing-library/react";
import { Play } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import ThumbnailTile from "./ThumbnailTile";

function tile(src: string | null, props: { priority?: boolean; hoverScale?: boolean } = {}) {
  return <ThumbnailTile src={src} alt="Intro" fallbackIcon={Play} {...props} />;
}

describe("ThumbnailTile", () => {
  it("loads lazily, at no special priority, by default", () => {
    render(tile("/thumbs/a.png"));

    const img = screen.getByRole("img", { name: "Intro" });
    expect(img).toHaveAttribute("src", "/thumbs/a.png");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
    expect(img).toHaveClass("size-full", "object-cover");
    expect(img).not.toHaveClass("group-hover:scale-105");
  });

  it("loads a priority image eagerly at high priority, and zooms on hover when asked", () => {
    render(tile("/thumbs/a.png", { priority: true, hoverScale: true }));

    const img = screen.getByRole("img", { name: "Intro" });
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
    expect(img).toHaveClass("transition-transform", "group-hover:scale-105");
  });

  it("shows the placeholder when there is no image", () => {
    const { container } = render(tile(null));

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("shows the placeholder when the image fails, and tries a new source again", () => {
    const { container, rerender } = render(tile("/thumbs/a.png"));

    fireEvent.error(screen.getByRole("img", { name: "Intro" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();

    rerender(tile("/thumbs/b.png"));
    expect(screen.getByRole("img", { name: "Intro" })).toHaveAttribute("src", "/thumbs/b.png");

    fireEvent.error(screen.getByRole("img", { name: "Intro" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
