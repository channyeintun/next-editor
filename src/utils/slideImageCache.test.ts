import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  inlinableSlideImageHrefs,
  loadSlideImages,
  peekSlideImages,
  retainSlideImages,
} from "./slideImageCache";

const PNG = "/media/slide-images/aaa";
const JPEG = "/media/slide-images/bbb";

function respond(type: string, ok = true) {
  return { ok, blob: async () => new Blob(["bytes"], { type }) };
}

const fetchImage = vi.fn<(href: string) => Promise<ReturnType<typeof respond>>>();

beforeEach(() => {
  fetchImage
    .mockReset()
    .mockImplementation(async (href) => respond(href === JPEG ? "image/jpeg" : "image/png"));
  vi.stubGlobal("fetch", fetchImage);
});

afterEach(() => {
  retainSlideImages([]);
  vi.unstubAllGlobals();
});

describe("inlinableSlideImageHrefs", () => {
  it("collects each same-origin image href once", () => {
    const svg =
      `<svg><image xlink:href="${PNG}"/><image href='${PNG}'/>` +
      `<image xlink:href="/api/proxy?url=https%3A%2F%2Flh3.example%2Fx"/>` +
      `<a xlink:href="https://xstate.js.org/"/><use href="#clip"/>` +
      `<image href="//evil.example/media/x"/></svg>`;

    expect(inlinableSlideImageHrefs(svg)).toEqual([
      PNG,
      "/api/proxy?url=https%3A%2F%2Flh3.example%2Fx",
    ]);
  });
});

describe("loadSlideImages", () => {
  it("fetches each image once and serves it from memory afterwards", async () => {
    expect(peekSlideImages([PNG, JPEG])).toBeNull();

    const [first, second] = await Promise.all([
      loadSlideImages([PNG, JPEG]),
      loadSlideImages([JPEG]),
    ]);

    expect(first.get(PNG)).toBe(`data:image/png;base64,${btoa("bytes")}`);
    expect(first.get(JPEG)).toMatch(/^data:image\/jpeg;base64,/);
    expect(second.get(JPEG)).toBe(first.get(JPEG));
    expect(peekSlideImages([JPEG, PNG])).toEqual(new Map([...second, [PNG, first.get(PNG)]]));
    await loadSlideImages([PNG]);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("leaves out an image it cannot inline, so the frame loads it itself", async () => {
    fetchImage.mockImplementation(async (href) =>
      href === PNG ? respond("application/octet-stream") : respond("image/png", false),
    );
    const failing = "/media/slide-images/ccc";
    fetchImage.mockImplementationOnce(async () => {
      throw new TypeError("offline");
    });

    const images = await loadSlideImages([failing, PNG, JPEG]);

    expect(images.size).toBe(0);
    // Settled as not inlinable: the slide renders at once instead of waiting again.
    expect(peekSlideImages([failing, PNG, JPEG])).toEqual(new Map());
  });

  it("forgets the images of a deck no longer shown", async () => {
    await loadSlideImages([PNG, JPEG]);

    retainSlideImages([JPEG]);

    expect(peekSlideImages([JPEG])?.size).toBe(1);
    expect(peekSlideImages([PNG])).toBeNull();
    await loadSlideImages([PNG]);
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });
});
