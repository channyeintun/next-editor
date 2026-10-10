import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Lesson } from "../../lessons/types";
import type { Env } from "../env";
import { findPublishedLessonBySlug } from "../lessonCatalog";
import { serveLessonDetailDocument } from "./lessonDetailRoute";

vi.mock("../lessonCatalog", () => ({
  findPublishedLessonBySlug: vi.fn<(env: Env, slug: string) => Promise<Lesson | null>>(),
}));

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL("../../../index.html", import.meta.url)),
  "utf8",
);

const LESSON: Lesson = {
  slug: "rust-ownership",
  title: "Ownership & Borrowing",
  description: "Move semantics and borrows.",
  thumbnail: "media/lessons/abc/thumb.webp",
  ne: "media/lessons/abc/lesson.ne",
  duration: "12:30",
  tags: ["rust"],
  author: "Chan Nyein Tun",
  authorUrl: "/learn/@chan",
  publishedAt: "2026-07-20",
};

const assetsFetch = vi.fn<(request: Request) => Promise<Response>>();

function shellResponse(): Response {
  return new Response(INDEX_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", etag: '"shell"' },
  });
}

function env(): Env {
  return {
    ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
    PUBLIC_URL: "https://nexteditor.dev",
  } as Env;
}

function serve(slug: string): Promise<Response> {
  return serveLessonDetailDocument(
    env(),
    new Request(`https://nexteditor.dev/learn/${slug}`),
    slug,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  assetsFetch.mockImplementation(async () => shellResponse());
});

describe("lesson detail route", () => {
  it("looks the lesson up while the shell is still being fetched", async () => {
    let releaseShell!: (response: Response) => void;
    assetsFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseShell = resolve;
      }),
    );
    vi.mocked(findPublishedLessonBySlug).mockResolvedValue(LESSON);

    const pending = serve(LESSON.slug);
    await Promise.resolve();

    // Both waits have started before either has finished.
    expect(assetsFetch).toHaveBeenCalledTimes(1);
    expect(findPublishedLessonBySlug).toHaveBeenCalledWith(expect.anything(), LESSON.slug);

    releaseShell(shellResponse());
    const response = await pending;
    const document = await response.text();

    expect(response.status).toBe(200);
    expect(document).toContain("<title>Ownership &amp; Borrowing | Next Editor</title>");
    expect(document).toContain(
      '<link rel="canonical" href="https://nexteditor.dev/learn/rust-ownership"',
    );
  });

  it("answers an unknown slug with the shell as a noindex 404", async () => {
    vi.mocked(findPublishedLessonBySlug).mockResolvedValue(null);

    const response = await serve("no-such-lesson");
    const document = await response.text();

    expect(response.status).toBe(404);
    expect(document).toContain('<meta name="robots" content="noindex,follow" />');
  });

  it("serves the untouched shell when the lookup fails, never a 404", async () => {
    const failure = new Error("D1_ERROR: network connection lost");
    vi.mocked(findPublishedLessonBySlug).mockRejectedValue(failure);

    const response = await serve(LESSON.slug);

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"shell"');
    expect(await response.text()).toBe(INDEX_HTML);
    expect(console.error).toHaveBeenCalledWith(
      "Lesson detail SSR failed",
      { slug: LESSON.slug },
      failure,
    );
  });

  it("serves author profiles the shell without a lesson lookup", async () => {
    const response = await serve("@chan");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    expect(findPublishedLessonBySlug).not.toHaveBeenCalled();
  });

  it("passes a shell revalidation through untouched", async () => {
    assetsFetch.mockResolvedValue(
      new Response(null, { status: 304, headers: { etag: '"shell"' } }),
    );
    vi.mocked(findPublishedLessonBySlug).mockResolvedValue(LESSON);

    const response = await serve(LESSON.slug);

    expect(response.status).toBe(304);
  });
});
