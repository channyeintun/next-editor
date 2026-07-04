import { afterEach, describe, expect, it, vi } from "vitest";
import fixtureHtml from "./__fixtures__/published-deck.html?raw";
import { fetchPublishedDeck } from "./fetchPublishedDeck";
import { GoogleSlidesParseError } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: string, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn<() => Promise<Response>>(
      async () => ({ ok, status, text: async () => body }) as unknown as Response,
    ),
  );
}

describe("fetchPublishedDeck", () => {
  it("rejects an editor URL with a publish hint before fetching", async () => {
    const spy = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", spy);
    await expect(
      fetchPublishedDeck("https://docs.google.com/presentation/d/1AbC/edit"),
    ).rejects.toThrow(/Publish to web/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-Google URL", async () => {
    await expect(fetchPublishedDeck("https://example.com/deck")).rejects.toBeInstanceOf(
      GoogleSlidesParseError,
    );
  });

  it("fetches, parses, and normalizes a published deck", async () => {
    mockFetch(fixtureHtml);
    const deck = await fetchPublishedDeck(
      "https://docs.google.com/presentation/d/e/TOKEN/pub?start=false#slide=id.p",
    );
    // Query and hash are stripped from the stored source URL.
    expect(deck.sourceUrl).toBe("https://docs.google.com/presentation/d/e/TOKEN/pub");
    expect(deck.slides).toHaveLength(2);
    // Normalization ran: tabindex gone, redirect href unwrapped.
    expect(deck.slides[0].svg).not.toContain("tabindex");
    expect(deck.slides[0].svg).toContain('xlink:href="https://example.com/docs"');
  });

  it("surfaces a friendly error on a non-OK response", async () => {
    mockFetch("nope", false, 404);
    await expect(
      fetchPublishedDeck("https://docs.google.com/presentation/d/e/TOKEN/pub"),
    ).rejects.toThrow(/HTTP 404/);
  });
});
