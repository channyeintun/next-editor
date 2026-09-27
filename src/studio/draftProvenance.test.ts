import { describe, expect, it } from "vite-plus/test";
import { describeDraftProvenance, type DraftProvenanceRun } from "./draftProvenance";

function run(overrides: Partial<DraftProvenanceRun>): DraftProvenanceRun {
  return {
    result: {
      manifest: {
        planSlug: "rust-borrow",
        planHash: "0123456789abcdef0123456789abcdef",
        runtimeMode: "fixture",
      },
    },
    narrationProvider: null,
    voiceName: null,
    ...overrides,
  };
}

describe("describeDraftProvenance", () => {
  it("names the plan, a 16-character plan hash and the runtime", () => {
    expect(describeDraftProvenance(run({}))).toBe(
      "AI-produced draft — rendered unattended by the Next Editor studio (plan rust-borrow, plan sha256 0123456789abcdef, fixture runtime). Review the full lesson before publishing.",
    );
  });

  it("adds the narration provider and the cloned voice when the run had them", () => {
    expect(
      describeDraftProvenance(run({ narrationProvider: "Pocket-TTS", voiceName: "My voice" })),
    ).toBe(
      'AI-produced draft — rendered unattended by the Next Editor studio (plan rust-borrow, plan sha256 0123456789abcdef, fixture runtime, Pocket-TTS narration with the user-cloned voice "My voice"). Review the full lesson before publishing.',
    );
  });

  it("names a cloned voice without a provider, and skips empty names", () => {
    expect(describeDraftProvenance(run({ voiceName: "Studio" }))).toContain(
      'fixture runtime with the user-cloned voice "Studio").',
    );
    expect(describeDraftProvenance(run({ narrationProvider: "", voiceName: "" }))).toContain(
      "fixture runtime).",
    );
  });
});
