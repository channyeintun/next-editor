import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parseCaptionFile } from "./importCaptionFile";

const recovery = vi.hoisted(() => ({
  importWithChunkRecovery: vi.fn<(importer: () => Promise<unknown>, chunkName: string) => unknown>(
    (importer) => importer(),
  ),
}));

vi.mock("../routeRecovery", () => recovery);

afterEach(() => {
  vi.clearAllMocks();
});

const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n";

function pickedFile(text: string, name: string): File {
  return new File([text], name);
}

describe("parseCaptionFile", () => {
  it("loads the parser with the stale-chunk recovery and returns the file's cues", async () => {
    const parsed = await parseCaptionFile(pickedFile(vtt, "lesson.de.vtt"));

    expect(parsed).toEqual({
      cues: [{ start: 0, end: 1_000, text: "Hello" }],
      language: "de",
    });
    expect(recovery.importWithChunkRecovery).toHaveBeenCalledWith(
      expect.any(Function),
      "parseCaptions",
    );
  });

  it("asks for the file again when the parser cannot load after its one reload", async () => {
    recovery.importWithChunkRecovery.mockRejectedValueOnce(
      new TypeError("Failed to fetch dynamically imported module"),
    );

    expect(await parseCaptionFile(pickedFile(vtt, "lesson.vtt"))).toEqual({
      error: `Couldn't read "lesson.vtt" — try selecting it again.`,
    });
  });

  it("says so when the file holds no captions", async () => {
    expect(await parseCaptionFile(pickedFile("not captions", "notes.vtt"))).toEqual({
      error: `No captions found in "notes.vtt" — expected WebVTT or SRT.`,
    });
  });
});
