import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import type { PlaylistSummary } from "@next-editor/infra";
import PlaylistSummaryCard from "./PlaylistSummaryCard";

const playlist: PlaylistSummary = {
  slug: "rust-from-zero",
  title: "Rust from zero",
  description: "",
  lessonCount: 3,
  thumbnail: null,
};

function renderCard(overrides: Partial<PlaylistSummary> = {}) {
  render(
    <MemoryRouter>
      <PlaylistSummaryCard playlist={{ ...playlist, ...overrides }} />
    </MemoryRouter>,
  );
}

describe("PlaylistSummaryCard", () => {
  it("gives the title link the lesson count the hidden thumbnail badge shows", () => {
    renderCard();

    // The thumbnail link (and the count badge on it) is hidden from assistive
    // technology, so the only link left must carry the count, after the title.
    const link = screen.getByRole("link");
    expect(link).toHaveAccessibleName("Rust from zero, 3 lessons");
    expect(link).toHaveAttribute("href", "/learn/playlist/rust-from-zero");
  });

  it("uses the singular for a one-lesson playlist", () => {
    renderCard({ lessonCount: 1 });

    expect(screen.getByRole("link")).toHaveAccessibleName("Rust from zero, 1 lesson");
  });
});
