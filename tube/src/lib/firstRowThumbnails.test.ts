import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type FirstRowThumbnails = typeof import("./firstRowThumbnails");

let thumbnails: FirstRowThumbnails;

beforeEach(async () => {
  // The signal is once per page load, so every test gets a fresh module.
  vi.resetModules();
  thumbnails = await import("./firstRowThumbnails");
});

/** A first row as LessonGrid renders it: priority thumbnails, still loading unless said. */
function firstRow(...images: Array<{ priority: boolean; complete?: boolean }>) {
  const row = document.createElement("div");
  const elements = images.map(({ priority, complete = false }) => {
    const image = document.createElement("img");
    image.src = "/media/lessons/thumbnail.jpg";
    if (priority) image.setAttribute("fetchpriority", "high");
    Object.defineProperty(image, "complete", { value: complete });
    row.append(image);
    return image;
  });
  return { row, images: elements };
}

async function isSettled(): Promise<boolean> {
  let settled = false;
  void thumbnails.whenFirstRowThumbnailsSettled().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe("whenFirstRowThumbnailsSettled", () => {
  it("settles once every priority thumbnail has loaded or failed", async () => {
    const { row, images } = firstRow({ priority: true }, { priority: true }, { priority: false });
    thumbnails.observeFirstRowThumbnails(row);
    expect(await isSettled()).toBe(false);

    images[0].dispatchEvent(new Event("load"));
    expect(await isSettled()).toBe(false);

    // A failed thumbnail counts as settled, and the low-priority image, still
    // loading, is not part of the wait.
    images[1].dispatchEvent(new Event("error"));
    expect(await isSettled()).toBe(true);
  });

  it("does not wait for thumbnails that had already loaded", async () => {
    const { row } = firstRow({ priority: true, complete: true });
    thumbnails.observeFirstRowThumbnails(row);

    expect(await isSettled()).toBe(true);
  });

  it("settles at once for a row without a thumbnail", async () => {
    thumbnails.observeFirstRowThumbnails(firstRow({ priority: false }).row);

    expect(await isSettled()).toBe(true);
  });

  it("watches only the first row it is given", async () => {
    const first = firstRow({ priority: true });
    thumbnails.observeFirstRowThumbnails(first.row);
    // StrictMode and re-mounts call the ref again; the wait stays the same.
    thumbnails.observeFirstRowThumbnails(null);
    thumbnails.observeFirstRowThumbnails(firstRow({ priority: true, complete: true }).row);
    expect(await isSettled()).toBe(false);

    first.images[0].dispatchEvent(new Event("load"));
    expect(await isSettled()).toBe(true);
  });

  it("settles when the gallery has no first row to show", async () => {
    expect(await isSettled()).toBe(false);

    thumbnails.settleWithoutFirstRow();
    expect(await isSettled()).toBe(true);
  });
});
