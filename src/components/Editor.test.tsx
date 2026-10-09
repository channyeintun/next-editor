import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";

// Monaco and the rest of the workspace are not under test here; the loading
// overlay and its status region live in Editor's own layout.
vi.mock("./CodeEditor", () => ({ default: () => null }));

const loader = vi.hoisted(() => ({
  setIsLoading: null as Dispatch<SetStateAction<boolean>> | null,
}));

// The real loader only flips `isLoading` around a fetch; driving that state
// directly stands in for a `?url=` load, a dropped file, or a Retry.
vi.mock("../hooks/useUrlLoader", async () => {
  const { useState } = await import("react");
  return {
    useUrlLoader: () => {
      const [isLoading, setIsLoading] = useState(false);
      loader.setIsLoading = setIsLoading;
      return {
        fetchNextEditorFile: vi.fn<(url: string) => Promise<void>>(async () => {}),
        importNextEditorFile: vi.fn<(file: File) => Promise<void>>(async () => {}),
        isNextEditorUrl: () => false,
        isLoading,
        error: null,
        retry: undefined,
        clearError: () => {},
      };
    },
  };
});

const { default: Editor } = await import("./Editor");

function renderEditor() {
  // CollaborationProvider reads the signed-in user through react-query.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Editor
          readOnly
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
