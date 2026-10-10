import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The lesson lookup, as each test sets it.
const lessonQuery = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../hooks/useLessons", () => ({ useLesson: () => lessonQuery.current }));
// Both views' chunks still downloading, so each test sees its fallback.
vi.mock("../lessonRouteLoaders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lessonRouteLoaders")>()),
  loadLessonDetailRoute: () => new Promise<never>(() => {}),
  loadAuthorProfilePage: () => new Promise<never>(() => {}),
}));

const { default: LearnSlugRoute } = await import("./LearnSlugRoute");

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/learn/:slug" element={<LearnSlugRoute />} />
        <Route path="/learn" element={<p>gallery</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  document.title = "Lessons | Next Editor";
});

describe("LearnSlugRoute while a view's chunk downloads", () => {
  it("shows the lesson's skeleton and titles the page as the lesson view will", () => {
    lessonQuery.current = {
      data: { title: "Closures in Rust" },
      isPending: false,
      isError: false,
    };
    renderAt("/learn/closures-in-rust");

    expect(document.title).toBe("Closures in Rust | Next Editor");
    // The skeleton's breadcrumb names the lesson from its slug.
    expect(screen.getByText("closures in rust")).toBeInTheDocument();
  });

  it("names an uncached lesson from its slug", () => {
    lessonQuery.current = { data: undefined, isPending: true, isError: false };
    renderAt("/learn/closures-in-rust");

    expect(document.title).toBe("closures in rust | Next Editor");
  });

  it("shows a loading status for an author profile, titled by its handle", () => {
    renderAt("/learn/@ada");

    expect(document.title).toBe("@ada | Next Editor");
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  it("sends an empty handle back to the gallery", () => {
    renderAt("/learn/@");

    expect(screen.getByText("gallery")).toBeInTheDocument();
  });
});
