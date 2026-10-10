import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { useCodeEditorComponent } from "./useCodeEditorComponent";

// Holds the CodeEditor chunk until the test lets it load.
const chunk = vi.hoisted(() => {
  let load!: () => void;
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  return { loaded, load, lazyImports: 0 };
});

vi.mock("./CodeEditor", async () => {
  await chunk.loaded;
  return { default: () => <div data-testid="code-editor" /> };
});

// Counts the imports Editor's React.lazy CodeEditor makes.
vi.mock("../routeRecovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routeRecovery")>();
  const lazyWithRecovery: typeof actual.lazyWithRecovery = (importer, chunkName) =>
    actual.lazyWithRecovery(() => {
      if (chunkName === "CodeEditor") chunk.lazyImports += 1;
      return importer();
    }, chunkName);
  return { ...actual, lazyWithRecovery };
});

vi.mock("./useCodeEditorComponent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useCodeEditorComponent")>();
  return {
    ...actual,
    useCodeEditorComponent: vi.fn<typeof actual.useCodeEditorComponent>(
      actual.useCodeEditorComponent,
    ),
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

describe("Editor revealing CodeEditor", () => {
  it("shows the skeleton while the chunk loads, then CodeEditor through a state update", async () => {
    renderEditor();
    expect(screen.getByRole("status", { name: "Loading editor" })).toBeInTheDocument();
    expect(screen.queryByTestId("code-editor")).not.toBeInTheDocument();

    await act(async () => {
      chunk.load();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId("code-editor")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading editor" })).not.toBeInTheDocument();
    // Not through React.lazy: React holds a Suspense retry back until 300 ms
    // after the fallback appeared, which delayed the code's first paint.
    expect(chunk.lazyImports).toBe(0);
  });

  it("falls back to the lazy CodeEditor once the import has failed for good", async () => {
    chunk.load();
    vi.mocked(useCodeEditorComponent).mockReturnValue({ CodeEditor: null, failed: true });

    renderEditor();

    expect(await screen.findByTestId("code-editor")).toBeInTheDocument();
    expect(chunk.lazyImports).toBe(1);
  });
});
