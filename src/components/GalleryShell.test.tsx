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

  // The navbar's height must not change when the session resolves (its
  // actions go from nothing, to AuthMenu's placeholder, to a signed-out row or
  // an avatar), or the whole page under it shifts. jsdom has no layout, so
  // this checks that the page and the skeleton reserve the same slot.
  it("keeps the navbar's actions in one fixed-height slot, with or without actions", () => {
    const page = render(
      <MemoryRouter>
        <GalleryShell actions={<button type="button">Account</button>} />
      </MemoryRouter>,
    );
    const slot = screen.getByRole("button", { name: "Account" }).parentElement;
    expect(slot).toHaveClass("min-h-[42px]");
    page.unmount();

    const { container } = render(
      <MemoryRouter>
        <LessonGallerySkeleton />
      </MemoryRouter>,
    );
    const emptySlot = container.querySelector("nav")?.lastElementChild?.lastElementChild;
    expect(emptySlot).toHaveClass("min-h-[42px]");
    expect(emptySlot).toBeEmptyDOMElement();
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
