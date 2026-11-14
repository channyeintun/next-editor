import { describe, expect, it, vi } from "vite-plus/test";
import type { LessonScript } from "../script/schema";
import { MODAL_VOXCPM2_BURMESE_PROFILE } from "../tts/profiles";
import { narrationCoverageOf, type NarrationCoverageDeps } from "./coverage";
import type { NarrationPackLesson } from "./requestPack";

/** Lessons the stand-in Director narrates as the request hashes given for them. */
function setup(requestsBySlug: Record<string, string[]>, cached: string[] = []) {
  const slugOf = new Map<LessonScript, string>();
  const lessons: NarrationPackLesson[] = Object.keys(requestsBySlug).map((slug) => {
    const script = { build: { seed: 1 } } as LessonScript;
    slugOf.set(script, slug);
    return { slug, script };
  });
  const kept = new Set(cached);
  const deps = {
    requestsOf: vi.fn<NarrationCoverageDeps["requestsOf"]>(async (script) => ({
      profile: MODAL_VOXCPM2_BURMESE_PROFILE,
      requests: (requestsBySlug[slugOf.get(script) ?? ""] ?? []).map((requestHash, index) => ({
        requestHash,
        // Two characters per dialog, so the character count is twice the dialog count.
        speechText: "ကခ",
        seed: 1,
        label: `dialog ${index + 1}`,
      })),
    })),
    hasCached: vi.fn<NarrationCoverageDeps["hasCached"]>(async (hash) => kept.has(hash)),
    cacheAvailable: vi.fn<NarrationCoverageDeps["cacheAvailable"]>(() => true),
  } satisfies NarrationCoverageDeps;
  return { lessons, deps };
}

describe("narrationCoverageOf", () => {
  it("counts, lesson by lesson, the dialogs this browser keeps no take for", async () => {
    const { lessons, deps } = setup(
      { first: ["a1", "a2"], second: ["b1", "b2", "b3"], third: ["c1"] },
      ["a1", "a2", "b1"],
    );

    expect(await narrationCoverageOf(lessons, { deps })).toEqual({
      lessons: [
        { slug: "first", dialogCount: 2, missingCount: 0 },
        { slug: "second", dialogCount: 3, missingCount: 2 },
        { slug: "third", dialogCount: 1, missingCount: 1 },
      ],
      missingDialogCount: 3,
      missingCharacterCount: 6,
      cacheUnavailable: null,
    });
  });

  it("counts a dialog once for the lesson that says it twice, and once across lessons that share it", async () => {
    const { lessons, deps } = setup(
      { first: ["shared", "shared", "a1"], second: ["shared", "b1"] },
      ["a1"],
    );

    const coverage = await narrationCoverageOf(lessons, { deps });

    expect(coverage.lessons).toEqual([
      { slug: "first", dialogCount: 2, missingCount: 1 },
      { slug: "second", dialogCount: 2, missingCount: 2 },
    ]);
    // Each lesson lacks the shared dialog; a render synthesizes it once.
    expect(coverage.missingDialogCount).toBe(2);
    expect(coverage.missingCharacterCount).toBe(4);
    expect(deps.hasCached).toHaveBeenCalledTimes(3);
  });

  it("says so when the browser cannot tell which takes it keeps", async () => {
    const { lessons, deps } = setup({ first: ["a1"] }, ["a1"]);
    deps.hasCached.mockImplementation(async (_hash, onUnavailable) => {
      onUnavailable?.("The operation is insecure");
      return false;
    });

    expect(await narrationCoverageOf(lessons, { deps })).toMatchObject({
      lessons: [{ slug: "first", dialogCount: 1, missingCount: 1 }],
      cacheUnavailable: "The operation is insecure",
    });

    deps.cacheAvailable.mockReturnValue(false);
    expect((await narrationCoverageOf(lessons, { deps })).cacheUnavailable).toBe(
      "Cache storage is not available in this page",
    );
  });

  it("has nothing to count for no lessons", async () => {
    const { deps } = setup({});

    expect(await narrationCoverageOf([], { deps })).toEqual({
      lessons: [],
      missingDialogCount: 0,
      missingCharacterCount: 0,
      cacheUnavailable: null,
    });
  });

  it("stops between lessons once the selection it counts for is gone", async () => {
    const { lessons, deps } = setup({ first: ["a1"], second: ["b1"], third: ["c1"] });
    const controller = new AbortController();
    deps.requestsOf.mockImplementationOnce(async () => {
      controller.abort(new Error("the selection changed"));
      return { profile: MODAL_VOXCPM2_BURMESE_PROFILE, requests: [] };
    });

    await expect(narrationCoverageOf(lessons, { deps, signal: controller.signal })).rejects.toThrow(
      "the selection changed",
    );
    expect(deps.requestsOf).toHaveBeenCalledTimes(1);
  });
});
