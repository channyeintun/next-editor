import { describe, expect, it } from "vite-plus/test";
import type { CaptionTrack } from "../core/src/types";
import { selectCaptionTrack } from "./captionTracks";

const studio: CaptionTrack = { id: "studio-narration", language: "en", label: "en-US", cues: [] };
const generated: CaptionTrack = { id: "auto-en-1", language: "en", label: "EN (auto)", cues: [] };
const french: CaptionTrack = { id: "fr", language: "fr", cues: [], default: true };

describe("selectCaptionTrack", () => {
  it("picks the track the viewer chose, even beside another in its language", () => {
    expect(selectCaptionTrack([studio, generated], { trackId: "auto-en-1", language: "en" })).toBe(
      generated,
    );
    expect(
      selectCaptionTrack([studio, generated], { trackId: "studio-narration", language: "en" }),
    ).toBe(studio);
  });

  it("falls back to the chosen language in a lesson without that track", () => {
    expect(selectCaptionTrack([french, studio], { trackId: "auto-en-9", language: "en" })).toBe(
      studio,
    );
  });

  // A viewer whose preference was saved before tracks had ids keeps their language.
  it("goes by language alone when no track was chosen", () => {
    expect(selectCaptionTrack([french, studio], { trackId: null, language: "en" })).toBe(studio);
  });

  it("shows the default, then the first, when nothing matches", () => {
    expect(selectCaptionTrack([studio, french], { trackId: null, language: "de" })).toBe(french);
    expect(selectCaptionTrack([studio, generated], { trackId: null, language: null })).toBe(studio);
  });

  it("has nothing to show without tracks", () => {
    expect(selectCaptionTrack(undefined, { trackId: "fr", language: "fr" })).toBeNull();
    expect(selectCaptionTrack([], { trackId: "fr", language: "fr" })).toBeNull();
  });
});
