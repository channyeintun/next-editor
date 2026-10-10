import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { onScreenImages, whenImagesSettle } from "./imagesSettled";

// An <img> still loading (complete is false) at `top`, 200 px tall.
function loadingImage(container: HTMLElement, top: number): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperty(image, "complete", { configurable: true, value: false });
  image.getBoundingClientRect = () =>
    ({ top, bottom: top + 200, left: 0, right: 300, width: 300, height: 200 }) as DOMRect;
  container.append(image);
  return image;
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("innerHeight", 1000);
  vi.stubGlobal("innerWidth", 1200);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe("whenImagesSettle", () => {
  it("settles once every image has loaded or failed", async () => {
    const first = loadingImage(container, 0);
    const second = loadingImage(container, 300);
    const settled = whenImagesSettle([first, second]);

    first.dispatchEvent(new Event("load"));
    expect(await isSettled(settled)).toBe(false);

    second.dispatchEvent(new Event("error"));
    expect(await isSettled(settled)).toBe(true);
  });

  it("settles at once for images that had already loaded, or none", async () => {
    const loaded = loadingImage(container, 0);
    Object.defineProperty(loaded, "complete", { value: true });

    expect(await isSettled(whenImagesSettle([loaded]))).toBe(true);
    expect(await isSettled(whenImagesSettle([]))).toBe(true);
  });
});

describe("onScreenImages", () => {
  it("keeps the images at least partly in the viewport", () => {
    const top = loadingImage(container, -100);
    const middle = loadingImage(container, 600);
    loadingImage(container, -300); // scrolled past
    loadingImage(container, 1400); // below the fold

    expect(onScreenImages(container)).toEqual([top, middle]);
  });
});
