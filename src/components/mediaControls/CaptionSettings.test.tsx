import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import CaptionSettings from "./CaptionSettings";
import type { CaptionTrack, Recording } from "../../core/src/types";
import type { CaptionGeneration } from "../../hooks/useCaptionGeneration";
import { downloadBlob } from "../../utils/downloadBlob";

vi.mock("../../utils/downloadBlob", () => ({
  downloadBlob: vi.fn<typeof import("../../utils/downloadBlob").downloadBlob>(),
}));

const lesson = { id: "lesson", name: "Lesson" } as Recording;
const english: CaptionTrack = {
  id: "en-1",
  language: "en",
  label: "EN",
  cues: [{ start: 0, end: 1000, text: "Hello" }],
};

const idle: CaptionGeneration = {
  state: { status: "idle" },
  start: vi.fn<CaptionGeneration["start"]>(async () => {}),
  cancel: vi.fn<CaptionGeneration["cancel"]>(),
};

function renderSettings({
  activeCaptionTrack = english,
  effectiveRecordMode = true,
  importError = null,
  onImport = () => {},
}: {
  activeCaptionTrack?: CaptionTrack | null;
  effectiveRecordMode?: boolean;
  importError?: string | null;
  onImport?: () => void;
} = {}) {
  return render(
    <CaptionSettings
      recording={lesson}
      effectiveRecordMode={effectiveRecordMode}
      captionGeneration={idle}
      activeCaptionTrack={activeCaptionTrack}
      importError={importError}
      onImport={onImport}
    />,
  );
}

const downloadButton = () => screen.queryByRole("button", { name: "Download captions (.vtt)" });

afterEach(() => {
  vi.clearAllMocks();
});

describe("CaptionSettings", () => {
  it("offers Download only to the author, and only with a track showing", () => {
    const { rerender } = renderSettings();
    expect(downloadButton()).toBeInTheDocument();

    rerender(
      <CaptionSettings
        recording={lesson}
        effectiveRecordMode
        captionGeneration={idle}
        activeCaptionTrack={null}
        importError={null}
        onImport={() => {}}
      />,
    );
    expect(downloadButton()).not.toBeInTheDocument();

    rerender(
      <CaptionSettings
        recording={lesson}
        effectiveRecordMode={false}
        captionGeneration={idle}
        activeCaptionTrack={english}
        importError={null}
        onImport={() => {}}
      />,
    );
    expect(downloadButton()).not.toBeInTheDocument();
  });

  it("saves the showing track as WebVTT named for the lesson and its language", () => {
    renderSettings();
    fireEvent.click(downloadButton()!);

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(blob.type).toBe("text/vtt");
    expect(filename).toBe("Lesson.en.vtt");
  });

  it("opens the picker from Import captions and announces a file it could not import", () => {
    const onImport = vi.fn<() => void>();
    renderSettings({ onImport, importError: 'No captions found in "notes.vtt"' });

    fireEvent.click(screen.getByRole("button", { name: "Import captions…" }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent('No captions found in "notes.vtt"');
  });
});
