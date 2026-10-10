import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getLoadedCodeEditor, loadCodeEditor, type CodeEditorComponent } from "./codeEditorLoader";
import { useCodeEditorComponent } from "./useCodeEditorComponent";

// The real loader imports CodeEditor, and Monaco with it.
vi.mock("./codeEditorLoader", () => ({
  getLoadedCodeEditor: vi.fn<() => CodeEditorComponent | null>(() => null),
  loadCodeEditor: vi.fn<typeof loadCodeEditor>(),
}));

const FakeCodeEditor = (() => null) as unknown as CodeEditorComponent;
const codeEditorModule = { default: FakeCodeEditor } as Awaited<ReturnType<typeof loadCodeEditor>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLoadedCodeEditor).mockReturnValue(null);
});

describe("useCodeEditorComponent", () => {
  it("is null while the chunk loads, then the component", async () => {
    let finishLoading!: () => void;
    vi.mocked(loadCodeEditor).mockReturnValue(
      new Promise((resolve) => {
        finishLoading = () => resolve(codeEditorModule);
      }),
    );

    const { result } = renderHook(() => useCodeEditorComponent());
    expect(result.current).toEqual({ CodeEditor: null, failed: false });

    finishLoading();
    await waitFor(() => {
      expect(result.current.CodeEditor).toBe(FakeCodeEditor);
    });
    expect(result.current.failed).toBe(false);
  });

  it("is the component from the first render once the chunk is in", () => {
    vi.mocked(getLoadedCodeEditor).mockReturnValue(FakeCodeEditor);
    vi.mocked(loadCodeEditor).mockResolvedValue(codeEditorModule);

    const { result } = renderHook(() => useCodeEditorComponent());

    expect(result.current).toEqual({ CodeEditor: FakeCodeEditor, failed: false });
  });

  it("reports an import that failed", async () => {
    vi.mocked(loadCodeEditor).mockRejectedValue(new Error("CodeEditor threw while evaluating"));

    const { result } = renderHook(() => useCodeEditorComponent());

    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });
    expect(result.current.CodeEditor).toBeNull();
  });
});
