// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_OPTIONS, parseArgs } from "./args.ts";
import {
  downloadRecording,
  isHumanRecording,
  lessonBySlug,
  newestLessons,
  SITE,
  type Fetch,
} from "./lessons.ts";

const lesson = (slug: string, tags = ["studio", "ai-produced"]) => ({
  slug,
  ne: `media/lessons/${slug}/${slug}.ne`,
  tags,
});

/** A site whose catalog has `pages`; every request it gets is recorded. */
function fakeSite(pages: Array<ReturnType<typeof lesson>[]>) {
  const requested: string[] = [];
  const fetchUrl: Fetch = async (url) => {
    requested.push(url);
    const page = /\/api\/lessons\?page=(\d+)$/.exec(url);
    if (page) {
      const index = Number(page[1]);
      const nextPage = index + 1 < pages.length ? index + 1 : null;
      return Response.json({ lessons: pages[index] ?? [], nextPage });
    }
    const one = /\/api\/lessons\/([^/?]+)$/.exec(url);
    if (one) {
      const found = pages.flat().find((each) => each.slug === one[1]);
      return found ? Response.json(found) : new Response("{}", { status: 404 });
    }
    if (url.endsWith(".ne")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response("", { status: 404 });
  };
  return { fetchUrl, requested };
}

describe("the catalog", () => {
  it("takes the newest N, reading only the pages it needs", async () => {
    const site = fakeSite([[lesson("a"), lesson("b")], [lesson("c"), lesson("d")], [lesson("e")]]);
    const lessons = await newestLessons(site.fetchUrl, 3);
    expect(lessons.map((each) => each.slug)).toEqual(["a", "b", "c"]);
    expect(site.requested).toEqual([`${SITE}/api/lessons?page=0`, `${SITE}/api/lessons?page=1`]);
  });

  it("stops at the last page when there are fewer than N", async () => {
    const site = fakeSite([[lesson("a")], [lesson("b")]]);
    expect((await newestLessons(site.fetchUrl, 10)).map((each) => each.slug)).toEqual(["a", "b"]);
  });

  it("refuses a row whose recording path the site would not serve", async () => {
    const odd = [
      { slug: "x", ne: "../secrets.ne" },
      { slug: "y", ne: "https://elsewhere.example/y.ne" },
      { slug: "Not A Slug", ne: "media/lessons/z/z.ne" },
      lesson("ok"),
    ];
    const site = fakeSite([odd as ReturnType<typeof lesson>[]]);
    expect((await newestLessons(site.fetchUrl, 5)).map((each) => each.slug)).toEqual(["ok"]);
  });

  it("finds one lesson by slug, and refuses a slug that is not one", async () => {
    const site = fakeSite([[lesson("rust-borrow", ["rust"])]]);
    const found = await lessonBySlug(site.fetchUrl, "rust-borrow");
    expect(found.ne).toBe("media/lessons/rust-borrow/rust-borrow.ne");
    expect(isHumanRecording(found)).toBe(true);
    await expect(lessonBySlug(site.fetchUrl, "../api")).rejects.toThrow("not a lesson slug");
    await expect(lessonBySlug(site.fetchUrl, "missing")).rejects.toThrow("HTTP 404");
  });

  it("downloads a recording into the folder it is given, from the site", async () => {
    const site = fakeSite([[lesson("a")]]);
    const folder = mkdtempSync(join(tmpdir(), "recordings-check-test-"));
    try {
      const { file, bytes } = await downloadRecording(site.fetchUrl, lesson("a"), folder);
      expect(file).toBe(join(folder, "a.ne"));
      expect([...readFileSync(file)]).toEqual([...bytes]);
      expect(site.requested).toEqual([`${SITE}/media/lessons/a/a.ne`]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the command line", () => {
  it("defaults to the newest 6, 10 cuts, seed 1, nothing kept", () => {
    expect(parseArgs([])).toEqual({ options: DEFAULT_OPTIONS });
  });

  it("reads every option", () => {
    expect(
      parseArgs(["--count=3", "--slug=a-b", "--slug=c", "--cuts=4", "--seed=0", "--keep"]),
    ).toEqual({ options: { count: 3, slugs: ["a-b", "c"], cuts: 4, seed: 0, keep: true } });
  });

  it("refuses what it does not know", () => {
    for (const bad of ["--count=0", "--count=x", "--cuts=-1", "--slug=../x", "--nope", "lesson"]) {
      expect({ bad, refused: "error" in parseArgs([bad]) }).toEqual({ bad, refused: true });
    }
  });
});
