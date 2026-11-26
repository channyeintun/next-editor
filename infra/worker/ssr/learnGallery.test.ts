import { hydrate, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import type { GalleryPage } from "../../lessons/galleryPages";
import type { GalleryItem, Lesson } from "../../lessons/types";
import { lessonKeys } from "../../lessons/queryKeys";
import { SERVER_QUERY_STATE_ELEMENT_ID } from "../../../src/shared/serverQueryState";
import { dehydrateGalleryFirstPage, injectGalleryDocument } from "./learnGallery";

const SHELL = "<!doctype html><html><head><title>Next Editor</title></head><body></body></html>";

function lesson(slug: string, thumbnail = `media/lessons/${slug}/${slug}-thumbnail-1.webp`) {
  return { slug, title: slug, description: "", thumbnail, ne: `media/lessons/${slug}/${slug}.ne` };
}

function lessonCard(slug: string, thumbnail?: string): GalleryItem {
  return { kind: "lesson", lesson: lesson(slug, thumbnail) };
}

function playlistCard(slug: string, thumbnail: string | null): GalleryItem {
  return {
    kind: "playlist",
    playlist: { slug, title: slug, description: "", lessonCount: 2, thumbnail },
  };
}

const PAGE: GalleryPage = {
  items: ["a", "b", "c", "d", "e"].map((slug) => lessonCard(slug)),
  nextPage: "d1:1",
};

function preloads(document: string): string[] {
  return document.match(/<link rel="preload" as="image"[^>]*>/g) ?? [];
}

describe("injectGalleryDocument", () => {
  it("preloads each first-row thumbnail under the media query that puts its card there", () => {
    const document = injectGalleryDocument(SHELL, PAGE);

    expect(preloads(document)).toEqual([
      '<link rel="preload" as="image" href="/media/lessons/a/a-thumbnail-1.webp" fetchpriority="high" />',
      '<link rel="preload" as="image" href="/media/lessons/b/b-thumbnail-1.webp" fetchpriority="high" media="(min-width: 640px)" />',
      '<link rel="preload" as="image" href="/media/lessons/c/c-thumbnail-1.webp" fetchpriority="high" media="(min-width: 1024px)" />',
      '<link rel="preload" as="image" href="/media/lessons/d/d-thumbnail-1.webp" fetchpriority="high" media="(min-width: 1280px)" />',
    ]);
    // In the head, where the preload scanner finds them before any script runs.
    expect(document.indexOf("</head>")).toBeGreaterThan(document.lastIndexOf('rel="preload"'));
  });

  it("preloads a first-row playlist's cover, as the card requests it", () => {
    const document = injectGalleryDocument(SHELL, {
      items: [playlistCard("rust", "media/lessons/first/first-thumbnail-1.webp"), lessonCard("b")],
      nextPage: null,
    });

    expect(preloads(document)).toEqual([
      '<link rel="preload" as="image" href="/media/lessons/first/first-thumbnail-1.webp" fetchpriority="high" />',
      '<link rel="preload" as="image" href="/media/lessons/b/b-thumbnail-1.webp" fetchpriority="high" media="(min-width: 640px)" />',
    ]);
  });

  it("preloads nothing for a card without a thumbnail", () => {
    const document = injectGalleryDocument(SHELL, {
      items: [lessonCard("a", ""), playlistCard("rust", null), lessonCard("c")],
      nextPage: null,
    });

    expect(preloads(document)).toHaveLength(1);
    expect(document).not.toContain('href="/"');
  });

  it("keeps an attacker-authored title inert inside the state script", () => {
    const hostile: Lesson = { ...lesson("x"), title: "</script><script>alert(1)</script>$'" };
    const document = injectGalleryDocument(SHELL, {
      items: [{ kind: "lesson", lesson: hostile }],
      nextPage: null,
    });

    expect(document.match(/<\/script>/g)).toHaveLength(1);
    expect(document).toContain(`id="${SERVER_QUERY_STATE_ELEMENT_ID}"`);
  });
});

describe("dehydrateGalleryFirstPage", () => {
  it("is the cache the client builds when it fetches page 0 itself", () => {
    const client = new QueryClient();
    hydrate(client, JSON.parse(JSON.stringify(dehydrateGalleryFirstPage(PAGE))));

    expect(client.getQueryData(lessonKeys.infinite)).toEqual({
      pages: [PAGE],
      pageParams: ["d1:0"],
    });
    // Each card's lesson under its detail key, as the client's queryFn primes it.
    expect(client.getQueryData(lessonKeys.detail("c"))).toEqual(lesson("c"));
  });

  it("primes no lesson for a playlist card", () => {
    const client = new QueryClient();
    const page: GalleryPage = { items: [playlistCard("rust", null)], nextPage: null };
    hydrate(client, JSON.parse(JSON.stringify(dehydrateGalleryFirstPage(page))));

    expect(client.getQueryData(lessonKeys.infinite)).toEqual({
      pages: [page],
      pageParams: ["d1:0"],
    });
    expect(client.getQueryData(lessonKeys.detail("rust"))).toBeUndefined();
  });
});
