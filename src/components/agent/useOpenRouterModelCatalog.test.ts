import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FALLBACK_MODEL_OPTIONS, type AgentModelOption } from "../../agent/modelCatalog";
import { useOpenRouterModelCatalog } from "./useOpenRouterModelCatalog";

const fetchModels = vi.hoisted(() =>
  vi.fn<(signal?: AbortSignal) => Promise<AgentModelOption[]>>(),
);

vi.mock("../../agent/modelCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/modelCatalog")>()),
  fetchOpenRouterModelOptions: fetchModels,
}));

const catalogModel: AgentModelOption = {
  id: "vendor/model-a",
  label: "Vendor: Model A",
  supportsImages: false,
};

function renderCatalog() {
  return renderHook(({ isSettingsOpen }) => useOpenRouterModelCatalog(isSettingsOpen), {
    initialProps: { isSettingsOpen: false },
  });
}

beforeEach(() => {
  fetchModels.mockReset();
});

describe("useOpenRouterModelCatalog", () => {
  it("offers the fallback models without fetching while the settings are closed", () => {
    const { result } = renderCatalog();

    expect(result.current).toEqual({
      modelOptions: FALLBACK_MODEL_OPTIONS,
      isModelCatalogLoading: false,
      modelCatalogError: null,
    });
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("fetches the models the first time the settings open, and only then", async () => {
    fetchModels.mockResolvedValue([catalogModel]);
    const { result, rerender } = renderCatalog();

    rerender({ isSettingsOpen: true });
    expect(result.current.isModelCatalogLoading).toBe(true);
    await waitFor(() => expect(result.current.modelOptions).toEqual([catalogModel]));
    expect(result.current.isModelCatalogLoading).toBe(false);
    expect(result.current.modelCatalogError).toBeNull();

    rerender({ isSettingsOpen: false });
    rerender({ isSettingsOpen: true });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(result.current.modelOptions).toEqual([catalogModel]);
  });

  it("keeps the fallbacks when OpenRouter lists no models, and asks again on the next open", async () => {
    fetchModels.mockResolvedValue([]);
    const { result, rerender } = renderCatalog();

    rerender({ isSettingsOpen: true });
    await waitFor(() =>
      expect(result.current.modelCatalogError).toBe(
        "OpenRouter returned no models; showing fallbacks.",
      ),
    );
    expect(result.current.modelOptions).toBe(FALLBACK_MODEL_OPTIONS);
    expect(result.current.isModelCatalogLoading).toBe(false);

    rerender({ isSettingsOpen: false });
    rerender({ isSettingsOpen: true });
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it("says why the fetch failed", async () => {
    fetchModels.mockRejectedValueOnce(new Error("OpenRouter model catalog returned 503"));
    const { result, rerender } = renderCatalog();

    rerender({ isSettingsOpen: true });
    await waitFor(() =>
      expect(result.current.modelCatalogError).toBe(
        "OpenRouter model catalog returned 503; showing fallback models.",
      ),
    );
    expect(result.current.isModelCatalogLoading).toBe(false);

    fetchModels.mockRejectedValueOnce("offline");
    rerender({ isSettingsOpen: false });
    rerender({ isSettingsOpen: true });
    await waitFor(() =>
      expect(result.current.modelCatalogError).toBe(
        "Could not load OpenRouter models; showing fallbacks.",
      ),
    );
  });

  it("abandons the fetch when the settings close before it finishes", async () => {
    let signal: AbortSignal | undefined;
    fetchModels.mockImplementation((abortSignal) => {
      signal = abortSignal;
      return new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const { result, rerender } = renderCatalog();

    rerender({ isSettingsOpen: true });
    rerender({ isSettingsOpen: false });

    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(result.current.modelCatalogError).toBeNull();
    expect(result.current.modelOptions).toBe(FALLBACK_MODEL_OPTIONS);
  });
});
