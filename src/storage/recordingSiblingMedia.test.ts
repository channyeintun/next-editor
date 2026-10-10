import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { loadRecordingNarration } from "./recordingSiblingMedia";

function recordingWith(media: Pick<Recording, "audioBlob" | "audioUrl">): Recording {
  return { id: "recording-1", name: "Narrated", ...media } as Recording;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadRecordingNarration", () => {
  it("returns the take's own narration without fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const audioBlob = new Blob(["take"], { type: "audio/webm" });

    await expect(
      loadRecordingNarration(
        recordingWith({ audioBlob, audioUrl: "https://example.test/narration.weba" }),
      ),
    ).resolves.toBe(audioBlob);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for a recording with no narration", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadRecordingNarration(recordingWith({}))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads a linked narration", async () => {
    const linked = new Blob(["linked"], { type: "audio/ogg" });
    const fetchMock = vi.fn<typeof fetch>(
      async () => ({ ok: true, status: 200, blob: async () => linked }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadRecordingNarration(recordingWith({ audioUrl: "https://example.test/narration.ogg" })),
    ).resolves.toBe(linked);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/narration.ogg");
  });

  it("throws with the status when the download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })),
    );

    await expect(
      loadRecordingNarration(recordingWith({ audioUrl: "https://example.test/missing.ogg" })),
    ).rejects.toThrow("The narration could not be loaded (404).");
  });
});
