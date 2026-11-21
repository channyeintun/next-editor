import { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useScrollMemory, useWindowScrollMemory } from "./useScrollMemory";

const scrollTo = vi.fn<(x: number, y: number) => void>();

/** The page moves to `offset`: the reader scrolls, or the browser does. */
function scrollPageTo(offset: number) {
  vi.spyOn(window, "scrollY", "get").mockReturnValue(offset);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

/**
 * Back or Forward begins: the browser restores the scroll position of the entry
 * it is going to (`offset`) on the page still on screen, before the router
 * renders that entry.
 */
function startTraversal(offset: number) {
  window.dispatchEvent(new PopStateEvent("popstate"));
  scrollPageTo(offset);
}

function Results() {
  useWindowScrollMemory("results");
  return <p>results</p>;
}

/** A view that keeps a layout: what it was restored with, and what it leaves. */
const restoredLayouts: (string | undefined)[] = [];
function Rows({ leaves }: { leaves: string }) {
  const { restored, remember } = useScrollMemory<string>("rows");
  restoredLayouts.push(restored && `${restored.layout}@${restored.offset}`);
  useLayoutEffect(() => () => remember(leaves), [remember, leaves]);
  return <p>rows</p>;
}

// The memory outlives a test, as it outlives a page in the app, so every app
// here starts in a history entry of its own unless a test names one.
let entries = 0;

/** /learn shows `view`; a lesson is another route, as in the app. */
function appWith(view: React.ReactNode, entry = `entry-${++entries}`) {
  const router = createMemoryRouter(
    [
      { path: "/learn", element: view },
      { path: "/learn/:slug", element: <p>lesson</p> },
    ],
    { initialEntries: [{ pathname: "/learn", key: entry }] },
  );
  const { unmount } = render(<RouterProvider router={router} />);
  return {
    go: (to: string | number) =>
      act(async () => {
        await router.navigate(to as string);
      }),
    unmount,
  };
}

beforeEach(() => {
  scrollTo.mockClear();
  restoredLayouts.length = 0;
  vi.stubGlobal("scrollTo", scrollTo);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWindowScrollMemory", () => {
  it("puts the page back where it was left on Back from a lesson", async () => {
    const app = appWith(<Results />);
    scrollPageTo(1840);
    await app.go("/learn/intro");
    scrollPageTo(0);
    expect(scrollTo).not.toHaveBeenCalled();

    await app.go(-1);

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 1840);
  });

  it("keeps the reader's offset when the view is left by Forward or Back", async () => {
    const app = appWith(<Results />);
    await app.go("/learn/intro");
    await app.go(-1);
    scrollPageTo(1840);

    // Forward to the lesson: its entry was at the top, and the browser puts
    // the page still on screen, the results, there first.
    startTraversal(0);
    await app.go(1);
    await app.go(-1);

    expect(scrollTo).toHaveBeenLastCalledWith(0, 1840);
  });

  it("follows the reader again once a traversal lands on the same view", async () => {
    const app = appWith(<Results />);
    // A second entry of the same route: the view stays mounted through both.
    await app.go("/learn?q=rust");
    scrollPageTo(1840);
    startTraversal(0);
    await app.go(-1);

    scrollPageTo(640);
    await app.go("/learn/intro");
    await app.go(-1);

    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
  });

  it("starts a new visit of the same page where the browser leaves it", async () => {
    const app = appWith(<Results />);
    scrollPageTo(1840);
    await app.go("/learn/intro");

    // A link to /learn, not Back: a new history entry.
    await app.go("/learn");

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("returns each history entry to its own offset", async () => {
    const app = appWith(<Results />);
    scrollPageTo(1840);
    await app.go("/learn/intro");
    await app.go("/learn");
    scrollPageTo(320);
    await app.go("/learn/intro");

    await app.go(-1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 320);
    await app.go(-1);
    await app.go(-1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1840);
  });

  it("forgets an offset that was for another viewport width", async () => {
    const app = appWith(<Results />);
    scrollPageTo(1840);
    await app.go("/learn/intro");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(window.innerWidth + 200);

    await app.go(-1);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("useScrollMemory", () => {
  it("gives a view back the layout it left with, and the offset to scroll to", async () => {
    const app = appWith(<Rows leaves="row heights" />);
    expect(restoredLayouts).toEqual([undefined]);
    scrollPageTo(960);
    await app.go("/learn/intro");

    await app.go(-1);

    expect(restoredLayouts.at(-1)).toBe("row heights@960");
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 960);
  });

  it("keeps the views of one history entry apart", () => {
    // One entry, first showing the rows, then the results in their place.
    const rows = appWith(<Rows leaves="row heights" />, "shared-entry");
    scrollPageTo(960);
    rows.unmount();

    appWith(<Results />, "shared-entry");

    // The results are a view of their own: the rows' offset is not theirs.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("remembers a view under the entry it mounted in, not the one it is left in", async () => {
    const app = appWith(<Rows leaves="row heights" />);
    // A search: a new entry of the same route, so the rows stay mounted.
    await app.go("/learn?q=rust");
    scrollPageTo(40);
    await app.go("/learn/intro");

    // Back to the search's entry: the rows mount in it for the first time.
    await app.go(-1);
    expect(restoredLayouts.at(-1)).toBeUndefined();

    // Back to the first entry, from a lesson: the rows left it at 40.
    await app.go("/learn/other");
    await app.go(-2);
    expect(restoredLayouts.at(-1)).toBe("row heights@40");
  });
});
