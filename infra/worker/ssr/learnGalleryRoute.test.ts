import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LessonsPage } from "../../lessons/lessonsPages";
import type { Env } from "../env";
import app from "../index";
import { readGalleryPage } from "../lessonCatalog";
import { serveLearnGalleryDocument } from "./learnGalleryRoute";

vi.mock("../lessonCatalog", () => ({
  findPublishedLessonBySlug: vi.fn<() => Promise<null>>(),
  readGalleryPage: vi.fn<(env: Env, page: number) => Promise<LessonsPage>>(),
}));

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL("../../../index.html", import.meta.url)),
  "utf8",
);

const PAGE: LessonsPage = {
  lessons: [
    {
      slug: "rust-ownership",
      title: "Ownership & Borrowing",
      description: "Move semantics and borrows.",
      thumbnail: "media/lessons/abc/abc-thumbnail-1791222405295.webp",
      ne: "media/lessons/abc/abc.ne",
    },
  ],
  nextPage: "d1:1",
};

const assetsFetch = vi.fn<(request: Request) => Promise<Response>>();

function shellResponse(): Response {
  return new Response(INDEX_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", etag: '"shell"' },
  });
}

function env(): Env {
  return { ASSETS: { fetch: assetsFetch } as unknown as Fetcher } as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  assetsFetch.mockImplementation(async () => shellResponse());
  vi.mocked(readGalleryPage).mockResolvedValue(PAGE);
});

describe("gallery route", () => {
  it("reads page 0 while the shell is fetched, then ships both in one document", async () => {
    let releaseShell!: (response: Response) => void;
    assetsFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseShell = resolve;
      }),
    );

    const pending = serveLearnGalleryDocument(env(), new Request("https://nexteditor.dev/learn"));
    await Promise.resolve();
    expect(assetsFetch).toHaveBeenCalledTimes(1);
    expect(readGalleryPage).toHaveBeenCalledWith(expect.anything(), 0);

    releaseShell(shellResponse());
    const response = await pending;
    const document = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    expect(document).toContain(
      '<link rel="preload" as="image" href="/media/lessons/abc/abc-thumbnail-1791222405295.webp" fetchpriority="high" />',
    );
    expect(document).toContain('<script type="application/json" id="__NE_QUERY_STATE__">');
    expect(document).toContain('"d1:1"');
  });

  it("asks for the shell by its canonical URL, without the browser's validators", async () => {
    await serveLearnGalleryDocument(
      env(),
      new Request("https://nexteditor.dev/learn", { headers: { "if-none-match": '"shell"' } }),
    );

    const [request] = assetsFetch.mock.calls[0];
    expect(request.url).toBe("https://nexteditor.dev/");
    expect(request.headers.has("if-none-match")).toBe(false);
  });

  it("serves the untouched shell when page 0 cannot be read", async () => {
    const failure = new Error("D1_ERROR: network connection lost");
    vi.mocked(readGalleryPage).mockRejectedValue(failure);

    const response = await serveLearnGalleryDocument(
      env(),
      new Request("https://nexteditor.dev/learn"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"shell"');
    expect(await response.text()).toBe(INDEX_HTML);
    expect(console.error).toHaveBeenCalledWith("Gallery SSR failed", failure);
  });

  it("answers HEAD with the shell, without reading D1", async () => {
    const response = await serveLearnGalleryDocument(
      env(),
      new Request("https://nexteditor.dev/learn", { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(readGalleryPage).not.toHaveBeenCalled();
  });

  it("serves /learn with a query string, cross-origin isolated like every response", async () => {
    const response = await app.request("https://nexteditor.dev/learn?from=home", {}, env());

    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(await response.text()).toContain('id="__NE_QUERY_STATE__"');
  });
});
