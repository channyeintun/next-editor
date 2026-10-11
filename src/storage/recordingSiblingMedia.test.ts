import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import {
  findWorkingAudioBlob,
  loadRecordingNarration,
  withResolvedMediaUrls,
} from "./recordingSiblingMedia";
import { decodeRecordingStream } from "./streamingRecordingCodec/decode";

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

  const linked = new Blob(["linked"], { type: "audio/ogg" });
  const linkedResponse = () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/ogg" }),
      blob: async () => linked,
    }) as Response;

  it("downloads a narration this site hosts directly", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => linkedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const audioUrl = `${window.location.origin}/lessons/narration.ogg`;

    await expect(loadRecordingNarration(recordingWith({ audioUrl }))).resolves.toBe(linked);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(audioUrl);
  });

  it("downloads another host's narration through the proxy, as the lesson's other files", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => linkedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const audioUrl = "https://cdn.other.test/narration.ogg";

    await expect(loadRecordingNarration(recordingWith({ audioUrl }))).resolves.toBe(linked);
    // A host without CORS is reachable only through the proxy.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${requested.origin}${requested.pathname}`).toBe(`${window.location.origin}/api/proxy`);
    expect(requested.searchParams.get("url")).toBe(audioUrl);
  });

  it("reads a narration held at a blob URL directly", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => linkedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const audioUrl = `blob:${window.location.origin}/narration`;

    await expect(loadRecordingNarration(recordingWith({ audioUrl }))).resolves.toBe(linked);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(audioUrl);
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

describe("the bundled introduction lesson", () => {
  // The landing demo and /learn play public/lessons/introduction/introduction.ne.
  const directory = "public/lessons/introduction";
  const fileOnDisk = (url: string) =>
    `${directory}/${decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")}`;

  it("names a narration file that ships beside it, so the first request finds it", async () => {
    const recording = decodeRecordingStream(
      new Uint8Array(readFileSync(`${directory}/introduction.ne`)),
    );
    const neUrl = `${window.location.origin}/lessons/introduction/introduction.ne`;
    // The static host: a missing file falls back to the app shell, 200 text/html.
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = fileOnDisk(String(input));
      return existsSync(path)
        ? new Response(readFileSync(path), { headers: { "content-type": "audio/ogg" } })
        : new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findWorkingAudioBlob(recording, neUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(found?.blob.type).toBe("audio/ogg");
    expect(new TextDecoder().decode(await found!.blob.slice(0, 4).arrayBuffer())).toBe("OggS");
    // The URL playback streams before that download completes is the same file.
    expect(withResolvedMediaUrls(recording, neUrl).audioUrl).toBe(found?.url);
  });
});
