import { describe, expect, it } from "vite-plus/test";
import type { GalleryItem, Lesson } from "./types";
import {
  FIRST_GALLERY_PAGE,
  galleryItemKey,
  galleryItemThumbnail,
  galleryLessons,
  galleryPageIndex,
  toGalleryPage,
} from "./galleryPages";

function lesson(slug: string, thumbnail = ""): Lesson {
  return { slug, title: slug, description: "", thumbnail, ne: `${slug}.ne` };
}

function lessonCard(slug: string, thumbnail = ""): GalleryItem {
  return { kind: "lesson", lesson: lesson(slug, thumbnail) };
}

function playlistCard(slug: string, thumbnail: string | null = null): GalleryItem {
  return {
    kind: "playlist",
    playlist: { slug, title: slug, description: "", lessonCount: 2, thumbnail },
  };
}

const SEED = [lesson("introduction")];

describe("toGalleryPage", () => {
  it("gives a page with more after it the next page's cursor and leaves the seed out", () => {
    const items = [playlistCard("rust"), lessonCard("newest")];

    expect(toGalleryPage({ items, nextPage: 1 }, SEED)).toEqual({ items, nextPage: "d1:1" });
  });

  it("appends the seed lessons as cards to the last page, an empty catalog's only page included", () => {
    expect(toGalleryPage({ items: [playlistCard("rust")], nextPage: null }, SEED)).toEqual({
      items: [playlistCard("rust"), lessonCard("introduction")],
      nextPage: null,
    });
    expect(toGalleryPage({ items: [], nextPage: null }, SEED).items).toEqual([
      lessonCard("introduction"),
    ]);
  });
});

describe("galleryPageIndex", () => {
  it("reads the D1 page a cursor names, from the first page's on", () => {
    expect(galleryPageIndex(FIRST_GALLERY_PAGE)).toBe(0);
    expect(galleryPageIndex("d1:3")).toBe(3);
  });

  it("starts from the first page for anything else", () => {
    expect(galleryPageIndex("seed:2")).toBe(0);
    expect(galleryPageIndex("d1:nope")).toBe(0);
  });
});

describe("gallery cards", () => {
  it("lists the lessons among them, which a playlist card is not", () => {
    expect(galleryLessons([playlistCard("rust"), lessonCard("a"), lessonCard("b")])).toEqual([
      lesson("a"),
      lesson("b"),
    ]);
  });

  it("tells a lesson from a playlist with the same slug", () => {
    expect(galleryItemKey(lessonCard("rust"))).toBe("lesson:rust");
    expect(galleryItemKey(playlistCard("rust"))).toBe("playlist:rust");
  });

  it("reads a card's cover, or null when it has none", () => {
    expect(galleryItemThumbnail(lessonCard("a", "media/a.webp"))).toBe("media/a.webp");
    expect(galleryItemThumbnail(playlistCard("rust", "media/first.webp"))).toBe("media/first.webp");
    expect(galleryItemThumbnail(lessonCard("a"))).toBeNull();
    expect(galleryItemThumbnail(playlistCard("rust"))).toBeNull();
  });
});
