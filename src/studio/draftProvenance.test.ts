import { describe, expect, it } from "vite-plus/test";
import {
  describeDraftDescription,
  describeDraftProvenance,
  type DraftProvenanceRun,
} from "./draftProvenance";

function run(overrides: Partial<DraftProvenanceRun>): DraftProvenanceRun {
  return {
    title: "Rust borrowing",
    result: {
      manifest: {
        planSlug: "rust-borrow",
        planHash: "0123456789abcdef0123456789abcdef",
        runtimeMode: "fixture",
      },
    },
    narrationProvider: null,
    voiceName: null,
    voiceKind: null,
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
      describeDraftProvenance(
        run({ narrationProvider: "Pocket-TTS", voiceName: "My voice", voiceKind: "cloned" }),
      ),
    ).toBe(
      'AI-produced draft — rendered unattended by the Next Editor studio (plan rust-borrow, plan sha256 0123456789abcdef, fixture runtime, Pocket-TTS narration with the user-cloned voice "My voice"). Review the full lesson before publishing.',
    );
  });

  it("names a VoxCPM2 narrator reference and an AthanLab voice by their kind", () => {
    expect(
      describeDraftProvenance(
        run({ narrationProvider: "VoxCPM2 (Modal)", voiceName: "Chan", voiceKind: "reference" }),
      ),
    ).toContain('VoxCPM2 (Modal) narration with the reference voice "Chan").');
    expect(
      describeDraftProvenance(
        run({ narrationProvider: "AthanLab", voiceName: "Nilar", voiceKind: "athanlab" }),
      ),
    ).toContain('AthanLab narration with the AthanLab voice "Nilar").');
  });

  it("names a voice without a provider, and skips empty names", () => {
    expect(describeDraftProvenance(run({ voiceName: "Studio", voiceKind: "cloned" }))).toContain(
      'fixture runtime with the user-cloned voice "Studio").',
    );
    expect(describeDraftProvenance(run({ voiceName: "Studio" }))).toContain(
      'fixture runtime with the voice "Studio").',
    );
    expect(describeDraftProvenance(run({ narrationProvider: "", voiceName: "" }))).toContain(
      "fixture runtime).",
    );
  });
});

describe("describeDraftDescription", () => {
  it("pre-fills the title and the AI-narration disclosure only", () => {
    expect(describeDraftDescription(run({}))).toBe(
      "Rust borrowing — a narrated coding lesson. The narration is AI-generated.",
    );
  });

  it("keeps build provenance and the review reminder out of the public text", () => {
    const description = describeDraftDescription(
      run({ narrationProvider: "AthanLab", voiceName: "My voice", voiceKind: "athanlab" }),
    );
    expect(description).not.toMatch(/sha256|rust-borrow|fixture|AthanLab|My voice|Review/);
  });

  it("falls back to a generic lead when the title is blank", () => {
    expect(describeDraftDescription(run({ title: "  " }))).toBe(
      "A narrated coding lesson. The narration is AI-generated.",
    );
  });
});
