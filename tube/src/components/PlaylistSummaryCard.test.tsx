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

function renderCard(overrides: Partial<PlaylistSummary> = {}, priority?: boolean) {
  return render(
    <MemoryRouter>
      <PlaylistSummaryCard playlist={{ ...playlist, ...overrides }} priority={priority} />
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

  it("marks the Burmese part of the title as lang=my", () => {
    renderCard({ title: "Rust တွေ" });

    const burmese = screen.getByRole("link").querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("တွေ");
  });

  it("uses the singular for a one-lesson playlist", () => {
    renderCard({ lessonCount: 1 });

    expect(screen.getByRole("link")).toHaveAccessibleName("Rust from zero, 1 lesson");
  });

  it("names the author and spells the count out in the gallery, where cards are of many authors", () => {
    const view = renderCard({ author: "Hla Hla", authorUrl: "/learn/@hla" });

    const author = screen.getByRole("link", { name: "Hla Hla" });
    expect(author).toHaveAttribute("href", "/learn/@hla");
    expect(view.container).toHaveTextContent("Hla Hla · 3 lessons");
    // The title link already reads the count out, so the visible one is not read again.
    expect(screen.getByText("· 3 lessons")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("shows no author line where the page is one author's", () => {
    const view = renderCard();

    expect(view.container.querySelector("p")).toBeNull();
  });

  it("loads the cover at once, at high priority, in the gallery's first row", () => {
    const cover = "media/lessons/first/first-thumbnail-1.webp";
    const lazy = renderCard({ thumbnail: cover });
    expect(lazy.container.querySelector("img")).toHaveAttribute("loading", "lazy");
    lazy.unmount();

    const eager = renderCard({ thumbnail: cover }, true);
    const image = eager.container.querySelector("img");
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveAttribute("fetchpriority", "high");
    expect(image).toHaveAttribute("src", `/${cover}`);
  });
});
