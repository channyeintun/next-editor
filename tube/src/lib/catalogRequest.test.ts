import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import axios from "axios";
import { REQUEST_TIMEOUT_MS, findCatalogItem, getCatalogJson } from "./catalogRequest";

vi.mock("axios", () => {
  const get =
    vi.fn<
      (
        url: string,
        config?: { timeout?: number },
      ) => Promise<{ data: unknown; headers: Record<string, unknown> }>
    >();
  return {
    default: {
      get,
      // apiClient (which owns the 404 rule) builds its instance at import.
      create: () => ({}),
      isAxiosError: (err: unknown): boolean =>
        typeof err === "object" && err !== null && "isAxiosError" in err,
    },
  };
});

function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

function jsonResponse(data: unknown) {
  return { data, headers: { "content-type": "application/json; charset=utf-8" } };
}

function htmlFallbackResponse() {
  return { data: "<!doctype html>...", headers: { "content-type": "text/html" } };
}

const mockedGet = vi.mocked(axios.get);

beforeEach(() => {
  mockedGet.mockReset();
});

describe("getCatalogJson", () => {
  it("returns the JSON body", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ slug: "a" }));
    await expect(getCatalogJson("/api/lessons/a")).resolves.toEqual({ slug: "a" });
  });

  // A stalled-but-accepted request never settles without a timeout, so Query's
  // retry never fires and the page sits on skeletons with no error to retry.
  it("bounds every request with the catalog timeout", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({}));
    await getCatalogJson("/api/playlists/p");
    expect(mockedGet).toHaveBeenCalledWith("/api/playlists/p", { timeout: 15_000 });
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("reads the SPA fallback (200 + text/html) as null", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    await expect(getCatalogJson("/api/lessons?page=0")).resolves.toBeNull();
  });

  // A list endpoint never 404s behind the Worker, so a 404 there is a real
  // failure for the error UI, not an empty result.
  it("rejects on a 404", async () => {
    const err = axiosError(404);
    mockedGet.mockRejectedValueOnce(err);
    await expect(getCatalogJson("/api/lessons?page=0")).rejects.toBe(err);
  });
});

describe("findCatalogItem", () => {
  it("returns the JSON body", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ slug: "p" }));
    await expect(findCatalogItem("/api/playlists/p")).resolves.toEqual({ slug: "p" });
    expect(mockedGet).toHaveBeenCalledWith("/api/playlists/p", { timeout: 15_000 });
  });

  it("reads a 404 as a miss", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    await expect(findCatalogItem("/api/playlists/nope")).resolves.toBeNull();
  });

  it("reads the SPA fallback as a miss", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    await expect(findCatalogItem("/api/playlists/nope")).resolves.toBeNull();
  });

  it("rethrows any other failure so the route can show its error", async () => {
    const err = axiosError(500);
    mockedGet.mockRejectedValueOnce(err);
    await expect(findCatalogItem("/api/playlists/p")).rejects.toBe(err);
  });
});
