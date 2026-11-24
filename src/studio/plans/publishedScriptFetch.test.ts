import { describe, expect, it, vi } from "vite-plus/test";
import { sha256Hex } from "../../shared/sha256Hex";
import {
  createPublishedScriptTexts,
  fetchPublishedScriptIndex,
  loadPublishedScriptText,
  MAX_SCRIPT_FETCHES,
  PublishedScriptMissingError,
} from "./publishedScriptFetch";
import {
  PUBLISHED_SCRIPT_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_PATH,
  parsePublishedScriptIndex,
  publishedScriptIdOfPath,
  type PublishedScriptIndex,
} from "./publishedScripts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type RefetchIndex = () => Promise<PublishedScriptIndex>;

const OLD_TEXT = "lesson:\n  slug: a\n  title: Old\n";
const NEW_TEXT = "lesson:\n  slug: a\n  title: New\n";
const OLD_ID = await sha256Hex(OLD_TEXT);
const NEW_ID = await sha256Hex(NEW_TEXT);

function scriptResponse(text: string): Response {
  return new Response(text, { headers: { "content-type": PUBLISHED_SCRIPT_CONTENT_TYPE } });
}

/** The app shell an unrouted path on this site answers with. */
function appShell(): Response {
  return new Response("<!doctype html><title>Next Editor</title>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** A site that serves these objects by id and 404s every other one. */
function siteWith(objects: Record<string, string>) {
  return vi.fn<Fetch>(async (input: string) => {
    const id = publishedScriptIdOfPath(input);
    const text = id === null ? undefined : objects[id];
    return text === undefined ? new Response("", { status: 404 }) : scriptResponse(text);
  });
}

function indexNaming(id: string): PublishedScriptIndex {
  return parsePublishedScriptIndex({
    version: 1,
    source: "abc123",
    lessons: { a: { id, bytes: 1, title: "A", locale: "en-US", runtimeMode: "fixture" } },
  });
}

describe("fetchPublishedScriptIndex", () => {
  it("reads the index", async () => {
    const fetchImpl = vi.fn<Fetch>(
      async () =>
        new Response(JSON.stringify(indexNaming(OLD_ID)), {
          headers: { "content-type": PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE },
        }),
    );
    const index = await fetchPublishedScriptIndex(undefined, fetchImpl);
    expect(index.lessons.a.id).toBe(OLD_ID);
    expect(fetchImpl).toHaveBeenCalledWith(PUBLISHED_SCRIPT_INDEX_PATH, { signal: undefined });
  });

  it("refuses the app shell a site without the route answers with", async () => {
    await expect(fetchPublishedScriptIndex(undefined, async () => appShell())).rejects.toThrow(
      /answered with text\/html/,
    );
  });

  it("says when nothing is published", async () => {
    await expect(
      fetchPublishedScriptIndex(undefined, async () => new Response("", { status: 404 })),
    ).rejects.toThrow(/No lessons are published/);
  });
});

describe("published script texts", () => {
  it("returns the text whose bytes hash to its id, and keeps it", async () => {
    const fetchImpl = siteWith({ [OLD_ID]: OLD_TEXT });
    const texts = createPublishedScriptTexts(fetchImpl);
    expect(await texts.textOf(OLD_ID)).toBe(OLD_TEXT);
    expect(await texts.textOf(OLD_ID)).toBe(OLD_TEXT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses bytes that do not hash to the id", async () => {
    const texts = createPublishedScriptTexts(async () => scriptResponse(NEW_TEXT));
    await expect(texts.textOf(OLD_ID)).rejects.toBeInstanceOf(PublishedScriptMissingError);
  });

  it("refuses a 200 with the app shell", async () => {
    const texts = createPublishedScriptTexts(async () => appShell());
    await expect(texts.textOf(OLD_ID)).rejects.toThrow(/answered with text\/html/);
  });

  it("shares a fetch in flight and forgets a failed one", async () => {
    let fail = true;
    const fetchImpl = vi.fn<Fetch>(async () =>
      fail ? new Response("", { status: 503 }) : scriptResponse(OLD_TEXT),
    );
    const texts = createPublishedScriptTexts(fetchImpl);
    const both = await Promise.allSettled([texts.textOf(OLD_ID), texts.textOf(OLD_ID)]);
    expect(both.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fail = false;
    expect(await texts.textOf(OLD_ID)).toBe(OLD_TEXT);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it(`runs at most ${MAX_SCRIPT_FETCHES} fetches at a time`, async () => {
    const bodies = Array.from({ length: MAX_SCRIPT_FETCHES * 2 }, (_, at) => `lesson ${at}\n`);
    const ids = await Promise.all(bodies.map((body) => sha256Hex(body)));
    const byId = new Map(ids.map((id, at) => [id, bodies[at]]));
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const texts = createPublishedScriptTexts(async (input) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return scriptResponse(byId.get(publishedScriptIdOfPath(input) ?? "") ?? "");
    });

    let done = false;
    const all = Promise.all(ids.map((id) => texts.textOf(id))).finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()?.();
    }
    expect(await all).toEqual(bodies);
    expect(most).toBe(MAX_SCRIPT_FETCHES);
  });

  it("stops waiting when its signal aborts, and stops the fetch once nobody waits", async () => {
    let fetchSignal: AbortSignal | undefined;
    const texts = createPublishedScriptTexts(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason));
        }),
    );
    const first = new AbortController();
    const second = new AbortController();
    const firstWait = texts.textOf(OLD_ID, first.signal);
    const secondWait = texts.textOf(OLD_ID, second.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.abort(new Error("first left"));
    await expect(firstWait).rejects.toThrow("first left");
    expect(fetchSignal?.aborted).toBe(false);

    second.abort(new Error("second left"));
    await expect(secondWait).rejects.toThrow("second left");
    expect(fetchSignal?.aborted).toBe(true);
  });
});

describe("loadPublishedScriptText", () => {
  it("reads the index again once on a missing object, and fetches the id it names now", async () => {
    const fetchImpl = siteWith({ [NEW_ID]: NEW_TEXT });
    const refetchIndex = vi.fn<RefetchIndex>(async () => indexNaming(NEW_ID));
    const loaded = await loadPublishedScriptText(
      createPublishedScriptTexts(fetchImpl),
      "a",
      OLD_ID,
      refetchIndex,
    );
    expect(loaded).toEqual({ id: NEW_ID, text: NEW_TEXT });
    expect(refetchIndex).toHaveBeenCalledTimes(1);
  });

  it("says the object is missing when the index still names it", async () => {
    const refetchIndex = vi.fn<RefetchIndex>(async () => indexNaming(OLD_ID));
    await expect(
      loadPublishedScriptText(createPublishedScriptTexts(siteWith({})), "a", OLD_ID, refetchIndex),
    ).rejects.toThrow(/published lesson object for "a" .* is missing.*published again/);
    expect(refetchIndex).toHaveBeenCalledTimes(1);
  });

  it("reads the index again on bytes that do not match their id", async () => {
    // A stale object at the old id: the bytes hash to something else.
    const fetchImpl = vi.fn<Fetch>(async (input: string) =>
      scriptResponse(publishedScriptIdOfPath(input) === NEW_ID ? NEW_TEXT : "tampered"),
    );
    const refetchIndex = vi.fn<RefetchIndex>(async () => indexNaming(NEW_ID));
    const loaded = await loadPublishedScriptText(
      createPublishedScriptTexts(fetchImpl),
      "a",
      OLD_ID,
      refetchIndex,
    );
    expect(loaded.id).toBe(NEW_ID);
    expect(refetchIndex).toHaveBeenCalledTimes(1);
  });

  it("does not read the index again for other failures", async () => {
    const refetchIndex = vi.fn<RefetchIndex>(async () => indexNaming(NEW_ID));
    await expect(
      loadPublishedScriptText(
        createPublishedScriptTexts(async () => appShell()),
        "a",
        OLD_ID,
        refetchIndex,
      ),
    ).rejects.toThrow(/text\/html/);
    expect(refetchIndex).not.toHaveBeenCalled();
  });
});
