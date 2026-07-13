import { afterEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_MODEL_OPTIONS, fetchOpenRouterModelOptions } from "./modelCatalog";

describe("OpenRouter model catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps every OpenRouter model, including free and non-tool variants", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "example/free-model:free",
              name: "Free model",
              architecture: { input_modalities: ["text"] },
              supported_parameters: [],
            },
            {
              id: "example/image-model",
              name: "Image model",
              architecture: { input_modalities: ["text", "image"] },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(fetchOpenRouterModelOptions()).resolves.toEqual([
      { id: "example/free-model:free", label: "Free model", supportsImages: false },
      { id: "example/image-model", label: "Image model", supportsImages: true },
    ]);
  });

  it("does not include the removed Gemma 4 31B entry in fallbacks", () => {
    expect(FALLBACK_MODEL_OPTIONS.map((option) => option.id)).not.toContain(
      "google/gemma-4-31b-it",
    );
  });
});
