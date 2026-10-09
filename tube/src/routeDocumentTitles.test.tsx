import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Each route's query result, as each test sets it.
const queries = vi.hoisted(() => ({
  lesson: {} as Record<string, unknown>,
  playlist: {} as Record<string, unknown>,
  auth: {} as Record<string, unknown>,
  profile: {} as Record<string, unknown>,
}));

vi.mock("./hooks/useLessons", () => ({ useLesson: () => queries.lesson }));
vi.mock("./hooks/usePlaylists", () => ({ usePlaylist: () => queries.playlist }));
vi.mock("@next-editor/infra", () => ({
  AuthMenu: () => null,
  avatarProxyUrl: (url: string) => url,
  useAuth: () => queries.auth,
  useAuthorProfile: () => queries.profile,
}));
// The editor and the signed-in library are beside the point here.
vi.mock("./components/LessonDetail", () => ({ default: () => null }));
vi.mock("./components/PlaylistDetail", () => ({ default: () => null }));
vi.mock("./components/MyLibraryGrid", () => ({ default: () => null }));
vi.mock("./components/UsernameEditor", () => ({ default: () => null }));

const { default: LessonDetailRoute } = await import("./components/LessonDetailRoute");
const { default: PlaylistDetailRoute } = await import("./components/PlaylistDetailRoute");
const { default: AuthorProfilePage } = await import("./AuthorProfilePage");

function query(overrides: Record<string, unknown>): Record<string, unknown> {
  return { data: undefined, isPending: false, isError: false, refetch: () => {}, ...overrides };
}

function at(path: string, pattern: string, element: ReactNode) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>
  );
}

// Fresh elements on every call: rerendering the same element object is a no-op.
const lessonPage = () => at("/learn/closures-in-rust", "/learn/:slug", <LessonDetailRoute />);
const playlistPage = () =>
  at("/learn/playlist/rust-from-zero", "/learn/playlist/:slug", <PlaylistDetailRoute />);
const profilePage = () => at("/learn/@ada", "/learn/:slug", <AuthorProfilePage username="ada" />);

beforeEach(() => {
  document.title = "A stale lesson | Next Editor";
});

describe("LessonDetailRoute's document title", () => {
  it("names the lesson from its slug until it loads, then by its own title", () => {
    queries.lesson = query({ isPending: true });
    const { rerender } = render(lessonPage());
    expect(document.title).toBe("closures in rust | Next Editor");

    queries.lesson = query({ data: { title: "Closures in Rust" } });
    rerender(lessonPage());
    expect(document.title).toBe("Closures in Rust | Next Editor");
  });

  it("says when the lesson is missing or failed to load", () => {
    queries.lesson = query({ data: null });
    const { rerender } = render(lessonPage());
    expect(document.title).toBe("Lesson not found | Next Editor");

    queries.lesson = query({ isError: true });
    rerender(lessonPage());
    expect(document.title).toBe("Failed to load lesson | Next Editor");
  });
});

describe("PlaylistDetailRoute's document title", () => {
  it("names the playlist once it loads", () => {
    queries.playlist = query({ isPending: true });
    const { rerender } = render(playlistPage());
    expect(document.title).toBe("Playlist | Next Editor");

    queries.playlist = query({ data: { title: "Rust from zero" } });
    rerender(playlistPage());
    expect(document.title).toBe("Rust from zero | Next Editor");
  });

  it("says when the playlist is missing or failed to load", () => {
    queries.playlist = query({ data: null });
    const { rerender } = render(playlistPage());
    expect(document.title).toBe("Playlist not found | Next Editor");

    queries.playlist = query({ isError: true });
    rerender(playlistPage());
    expect(document.title).toBe("Failed to load playlist | Next Editor");
  });
});

describe("AuthorProfilePage's document title", () => {
  const author = { user: { name: "Ada Lovelace", username: "ada" }, playlists: [], lessons: [] };

  it("names the author once the public profile loads", () => {
    queries.auth = { user: null, isLoading: true };
    queries.profile = query({ data: author });
    const { rerender } = render(profilePage());
    expect(document.title).toBe("@ada | Next Editor");

    // The profile was already cached: the page names the author in the same
    // commit that hands the title from the auth gate to the public profile.
    queries.auth = { user: null, isLoading: false };
    rerender(profilePage());
    expect(document.title).toBe("Ada Lovelace | Next Editor");
  });

  it("calls the owner's own profile My Library", () => {
    queries.auth = { user: { username: "ada" }, isLoading: false };
    render(profilePage());
    expect(document.title).toBe("My Library | Next Editor");
  });

  // One mount per state: the compiled AuthorProfilePage memoizes its
  // PublicAuthorProfile element, and the mocked query cannot re-render it the
  // way a real query result does.
  it.each([
    [{ isPending: true }, "@ada | Next Editor"],
    [{ data: null }, "Author not found | Next Editor"],
    [{ isError: true }, "Profile unavailable | Next Editor"],
  ])("titles a public profile in state %o as %s", (state, title) => {
    queries.auth = { user: null, isLoading: false };
    queries.profile = query(state);
    render(profilePage());
    expect(document.title).toBe(title);
  });
});
