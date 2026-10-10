import { useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const warmLessonRoute = vi.hoisted(() => vi.fn<() => void>());
vi.mock("../lessonRouteLoaders", () => ({ warmLessonRoute }));

const { useOnScreenThumbnailsSettled, useWarmLessonRoute } = await import("./useWarmLessonRoute");

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Page({ contentReady }: { contentReady: Promise<void> | null }) {
  useWarmLessonRoute(contentReady);
  return null;
}

// A page of cards whose one thumbnail is on screen and still loading.
function Cards() {
  const [cards, setCards] = useState<HTMLDivElement | null>(null);
  useWarmLessonRoute(useOnScreenThumbnailsSettled(cards));
  return (
    <div ref={setCards}>
      <img
        alt="A lesson"
        ref={(image) => {
          if (!image) return;
          Object.defineProperty(image, "complete", { configurable: true, value: false });
          image.getBoundingClientRect = () =>
            ({ top: 100, bottom: 300, left: 0, right: 300 }) as DOMRect;
        }}
      />
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  warmLessonRoute.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWarmLessonRoute", () => {
  it("warms the lesson route at idle once the page's thumbnails are in", async () => {
    const content = deferred();
    render(<Page contentReady={content.promise} />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(warmLessonRoute).not.toHaveBeenCalled();

    content.resolve();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(warmLessonRoute).toHaveBeenCalledTimes(1);

    // The cap that would have warmed it anyway does not warm it twice.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(warmLessonRoute).toHaveBeenCalledTimes(1);
  });

  it("warms it anyway when the thumbnails take too long", async () => {
    render(<Page contentReady={deferred().promise} />);
    await act(() => vi.advanceTimersByTimeAsync(5000 + 10));
    expect(warmLessonRoute).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the page is gone, or before it has content", async () => {
    const content = deferred();
    const { unmount } = render(<Page contentReady={content.promise} />);
    render(<Page contentReady={null} />);
    unmount();
    content.resolve();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(warmLessonRoute).not.toHaveBeenCalled();
  });
});

describe("useOnScreenThumbnailsSettled", () => {
  it("waits for the thumbnails on screen in the cards", async () => {
    const { getByRole } = render(<Cards />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(warmLessonRoute).not.toHaveBeenCalled();

    getByRole("img").dispatchEvent(new Event("load"));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(warmLessonRoute).toHaveBeenCalledTimes(1);
  });
});
