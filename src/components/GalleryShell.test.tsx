import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import GalleryShell from "./GalleryShell";
import LessonGallerySkeleton from "./LessonGallerySkeleton";

describe("GalleryShell", () => {
  it("renders the navbar, its actions and the children in one main landmark", () => {
    render(
      <MemoryRouter>
        <GalleryShell actions={<button type="button">Account</button>}>
          <h1>Lessons</h1>
        </GalleryShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation")).toContainElement(
      screen.getByRole("button", { name: "Account" }),
    );
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Lessons" }),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stands in for a loading page as one named status with its placeholders hidden", () => {
    const { container } = render(
      <MemoryRouter>
        <LessonGallerySkeleton />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status", { name: "Loading lessons" })).toBe(container.firstChild);
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    expect(container.querySelector("main")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("main .animate-pulse")).toHaveLength(9);
  });
});
