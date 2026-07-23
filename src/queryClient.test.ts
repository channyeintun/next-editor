import { afterEach, describe, expect, it } from "vitest";
import { injectLessonDocument } from "../infra/worker/ssr/lessonDetail";
import type { Lesson } from "../tube/src/types";
import { hydrateServerQueryState, queryClient } from "./queryClient";

const SHELL = "<!doctype html><html><head><title>Next Editor</title></head><body></body></html>";

const LESSON: Lesson = {
  slug: "rust-ownership",
  title: "Ownership & Borrowing",
  description: "Move semantics and borrows.",
  thumbnail: "media/lessons/abc/thumb.webp",
  ne: "media/lessons/abc/lesson.ne",
};

/** Reproduces what the browser receives: the Worker's document, parsed into this DOM. */
function loadServerDocument(lesson: Lesson, slug = lesson.slug) {
  const rendered = injectLessonDocument(SHELL, { lesson, slug, origin: "https://nexteditor.dev" });
  document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(rendered)![1];
}

afterEach(() => {
  document.head.innerHTML = "";
  queryClient.clear();
});

describe("hydrateServerQueryState", () => {
  // The Worker and this module hard-code the same element id in separate
  // packages; nothing but a round trip catches them drifting apart.
  it("adopts the lesson the edge already resolved", () => {
    loadServerDocument(LESSON);

    hydrateServerQueryState();

    expect(queryClient.getQueryData(["lessons", "detail", "rust-ownership"])).toEqual(LESSON);
  });

  it("no-ops on a document without server state", () => {
    document.head.innerHTML = "<title>Next Editor</title>";

    expect(() => hydrateServerQueryState()).not.toThrow();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("falls back to fetching when the payload is malformed", () => {
    document.head.innerHTML = '<script type="application/json" id="__NE_QUERY_STATE__">{</script>';

    expect(() => hydrateServerQueryState()).not.toThrow();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
