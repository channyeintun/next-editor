import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";

// Monaco and the rest of the workspace are not under test here; the loading
// overlay and its status region live in Editor's own layout.
vi.mock("./CodeEditor", () => ({ default: () => null }));

// The placeholder player bar is aria-hidden, so it is found by a test id.
vi.mock("./EditorShellSkeleton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./EditorShellSkeleton")>()),
  EditorPlayerBarSkeleton: () => <div data-testid="player-bar-skeleton" />,
}));

/** A load failure as the real loader records it: `url` is set when the load can be retried. */
type LoadFailure = { message: string; url?: string };

const loader = vi.hoisted(() => ({
  setIsLoading: null as Dispatch<SetStateAction<boolean>> | null,
  setFailure: null as Dispatch<SetStateAction<LoadFailure | null>> | null,
}));

// The real loader only flips `isLoading` around a fetch and records its failure;
// driving that state directly stands in for a `?url=` load, a dropped file, or a Retry.
vi.mock("../hooks/useUrlLoader", async () => {
  const { useState } = await import("react");
  return {
    useUrlLoader: () => {
      const [isLoading, setIsLoading] = useState(false);
      const [failure, setFailure] = useState<LoadFailure | null>(null);
      loader.setIsLoading = setIsLoading;
      loader.setFailure = setFailure;
      return {
        fetchNextEditorFile: vi.fn<(url: string) => Promise<void>>(async () => {}),
        importNextEditorFile: vi.fn<(file: File) => Promise<void>>(async () => {}),
        isNextEditorUrl: () => false,
        isLoading,
        error: failure?.message ?? null,
        retry: failure?.url ? () => {} : undefined,
        clearError: () => setFailure(null),
      };
    },
  };
});

const { default: Editor } = await import("./Editor");

const LESSON_URL = "https://example.com/lesson.ne";

function renderEditor({ recordingUrl }: { recordingUrl?: string } = {}) {
  // CollaborationProvider reads the signed-in user through react-query.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Editor
          readOnly
          recordingUrl={recordingUrl}
          runtimeAutoStart={false}
          recordingDrafts={false}
          persistWorkspace={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Editor recording-load status", () => {
  it("announces a load through a status region that is mounted before the load starts", async () => {
    renderEditor();

    const status = await screen.findByRole("status");
    expect(status).toBeEmptyDOMElement();

    act(() => loader.setIsLoading?.(true));

    // The same, already-mounted node carries the message, so it is announced.
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Loading recording…");

    act(() => loader.setIsLoading?.(false));

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it("keeps the visible spinner and text out of the accessibility tree while loading", async () => {
    renderEditor();
    await screen.findByRole("status");

    act(() => loader.setIsLoading?.(true));

    // Only the persistent region is exposed: no second status from the spinner,
    // and the visible copy is not read twice.
    const status = screen.getByRole("status");
    const visibleCopy = screen.getAllByText("Loading recording…").filter((node) => node !== status);
    expect(visibleCopy).toHaveLength(1);
    expect(visibleCopy[0]).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Editor recording-load error", () => {
  it("offers Dismiss beside Retry when a link fails, and Dismiss uncovers the editor", async () => {
    renderEditor({ recordingUrl: LESSON_URL });
    await screen.findByRole("status");

    act(() =>
      loader.setFailure?.({ message: "The lesson could not be fetched.", url: LESSON_URL }),
    );

    const panel = screen.getByRole("alert");
    expect(panel).toHaveTextContent("Couldn’t load this recording");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // No lesson is coming, so no placeholder player bar takes the error's place.
    expect(screen.queryByTestId("player-bar-skeleton")).not.toBeInTheDocument();
  });

  it("offers Dismiss alone for a dropped file, which can't be fetched again", async () => {
    renderEditor();
    await screen.findByRole("status");

    act(() => loader.setFailure?.({ message: "This file is not a recording." }));

    expect(screen.getByRole("alert")).toHaveTextContent("This file is not a recording.");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("brings the placeholder player bar back when a new load starts after a dismissal", async () => {
    renderEditor({ recordingUrl: LESSON_URL });
    await screen.findByRole("status");
    expect(screen.getByTestId("player-bar-skeleton")).toBeInTheDocument();

    act(() =>
      loader.setFailure?.({ message: "The lesson could not be fetched.", url: LESSON_URL }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("player-bar-skeleton")).not.toBeInTheDocument();

    act(() => loader.setIsLoading?.(true));

    expect(screen.getByTestId("player-bar-skeleton")).toBeInTheDocument();
  });
});
