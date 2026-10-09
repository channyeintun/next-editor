import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import type { Lesson } from "../types";
import LessonCard from "./LessonCard";

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    slug: "rust-data-types",
    title: "Rust from zero: Data type တွေ",
    description: "",
    thumbnail: "thumbs/rust-data-types.png",
    ne: "rust-data-types.ne",
    duration: "4:12",
    author: "Chan",
    ...overrides,
  };
}

function renderCard(value: Lesson) {
  return render(
    <MemoryRouter>
      <LessonCard lesson={value} />
    </MemoryRouter>,
  );
}

describe("LessonCard", () => {
  it("marks the Burmese part of the title link as lang=my", () => {
    renderCard(lesson());

    const link = screen.getByRole("link", { name: "Rust from zero: Data type တွေ" });
    const burmese = link.querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("တွေ");
  });

  it("clamps the title on the link itself so the heading does not clip its focus ring", () => {
    renderCard(lesson());

    const link = screen.getByRole("link", { name: "Rust from zero: Data type တွေ" });
    expect(link).toHaveClass("line-clamp-2", "focus-visible:ring-2");
    expect(screen.getByRole("heading", { level: 3 })).not.toHaveClass("line-clamp-2");
  });

  it("renders an English title with no lang override", () => {
    renderCard(lesson({ title: "Rust from zero: Ownership" }));

    const link = screen.getByRole("link", { name: "Rust from zero: Ownership" });
    expect(link.querySelector("[lang]")).toBeNull();
  });
});
