import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import CaptionsOverlay from "./CaptionsOverlay";
import { CaptionStoreProvider } from "../contexts/CaptionStoreContext";
import type { CaptionTrack, Recording } from "../core/src/types";

const player = vi.hoisted(() => ({
  recording: null as Recording | null,
  time: 0,
}));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ currentRecording: player.recording }),
  useLiveTimeValue: <T,>(derive: (currentTime: number) => T) => derive(player.time),
}));

const burmese: CaptionTrack = {
  id: "studio-narration",
  language: "my",
  label: "my-MM",
  cues: [{ start: 0, end: 2_000, text: "မင်္ဂလာပါ။" }],
};
const arabic: CaptionTrack = {
  id: "ar",
  language: "ar",
  cues: [{ start: 0, end: 2_000, text: "مرحبا" }],
};

function showCaptions(tracks: CaptionTrack[], pickedTrackId?: string) {
  window.localStorage.setItem("caption-enabled", "true");
  if (pickedTrackId) window.localStorage.setItem("caption-track", pickedTrackId);
  player.recording = { id: "lesson", captions: tracks } as unknown as Recording;
  player.time = 1_000;
  render(
    <CaptionStoreProvider>
      <CaptionsOverlay />
    </CaptionStoreProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  player.recording = null;
});

describe("CaptionsOverlay", () => {
  it("marks the caption with its track's language", () => {
    showCaptions([burmese]);
    const caption = screen.getByText("မင်္ဂလာပါ။");
    expect(caption).toHaveAttribute("lang", "my");
    expect(caption).not.toHaveAttribute("dir");
  });

  it("shows the picked track, right to left where its language is", () => {
    showCaptions([burmese, arabic], "ar");
    const caption = screen.getByText("مرحبا");
    expect(caption).toHaveAttribute("lang", "ar");
    expect(caption).toHaveAttribute("dir", "rtl");
  });
});
