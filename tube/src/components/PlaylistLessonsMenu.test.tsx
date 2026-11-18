import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import type { Playlist } from "../types";
import PlaylistLessonsMenu from "./PlaylistLessonsMenu";

const lesson = (slug: string, title: string, duration?: string) => ({
  slug,
  title,
  duration,
  description: "",
  thumbnail: "",
  ne: "",
});

const playlist: Playlist = {
  slug: "css-course",
  title: "CSS Course (မြန်မာလို)",
  description: "",
  lessons: [
    lesson("css-01", "CSS course 01", "6:10"),
    lesson("css-02", "CSS course 02"),
    lesson("css-03", "CSS course 03", "9:45"),
  ],
};

function renderMenu(currentSlug: string) {
  return render(
    <MemoryRouter>
      <PlaylistLessonsMenu playlist={playlist} currentSlug={currentSlug} />
    </MemoryRouter>,
  );
}

describe("PlaylistLessonsMenu", () => {
  it("lists every lesson in playlist order, each opening in the playlist", () => {
    renderMenu("css-02");

    const items = within(screen.getByRole("list")).getAllByRole("link");
    expect(items.map((link) => link.getAttribute("href"))).toEqual([
      "/learn/css-01?list=css-course",
      "/learn/css-02?list=css-course",
      "/learn/css-03?list=css-course",
    ]);
    // Position numbers are the ordered list's, not part of each link's name.
    expect(items[0]).toHaveAccessibleName("CSS course 01, 6:10");
  });

  it("marks the lesson playing as the current page and says where it sits", () => {
    renderMenu("css-02");

    expect(screen.getByRole("link", { current: "page" })).toHaveAccessibleName("CSS course 02");
    expect(screen.getAllByRole("link", { current: false })).toHaveLength(2);
    expect(screen.getByText("Lesson 2 of 3")).toBeInTheDocument();
  });

  it("marks the Burmese part of the playlist title as lang=my", () => {
    renderMenu("css-01");

    expect(screen.getByText("မြန်မာလို", { exact: false }).closest('[lang="my"]')).not.toBeNull();
  });
});
