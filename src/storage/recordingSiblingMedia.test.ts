import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import {
  findWorkingAudioUrl,
  loadRecordingNarration,
  withNarrationInMemory,
  withResolvedMediaUrls,
} from "./recordingSiblingMedia";
import { decodeRecordingStream } from "./streamingRecordingCodec/decode";

function recordingWith(
  media: Pick<Recording, "audioBlob" | "audioUrl" | "audioFile" | "audioSource">,
): Recording {
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

describe("loadRecordingNarration, for a host that does not say what the file is", () => {
  it("types the narration by its file name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(new TextEncoder().encode("OggS"))),
    );

    const narration = await loadRecordingNarration(
      recordingWith({
        audioUrl: `${window.location.origin}/media/narration.ogg`,
        audioFile: "narration.ogg",
      }),
    );

    expect(narration?.type).toBe("audio/ogg");
  });
});

describe("withNarrationInMemory", () => {
  it("downloads a narration that is only linked, for an export or an upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(new TextEncoder().encode("OggS"), {
            headers: { "content-type": "audio/ogg" },
          }),
      ),
    );
    const recording = recordingWith({ audioUrl: `${window.location.origin}/media/narration.ogg` });

    const attached = await withNarrationInMemory(recording);

    expect(attached.audioBlob?.type).toBe("audio/ogg");
    expect(attached.audioBlob?.size).toBe(4);
    // The loaded recording itself is left as it was.
    expect(recording.audioBlob).toBeUndefined();
  });

  it("leaves a recording that holds its narration, or has none, as it is", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const take = recordingWith({ audioBlob: new Blob(["take"], { type: "audio/webm" }) });
    const silent = recordingWith({});

    await expect(withNarrationInMemory(take)).resolves.toBe(take);
    await expect(withNarrationInMemory(silent)).resolves.toBe(silent);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("findWorkingAudioUrl", () => {
  const neUrl = `${window.location.origin}/lessons/intro-01.ne`;
  const urlOf = (file: string) => `${window.location.origin}/lessons/${file}`;

  it("probes a renamed narration's candidates and returns the one that is there", async () => {
    // The static host: a missing file falls back to the app shell, 200 text/html.
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input) === urlOf("intro-01.ogg")
        ? new Response(null, { headers: { "content-type": "audio/ogg" } })
        : new Response(null, { headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const recording = withResolvedMediaUrls(
      recordingWith({ audioFile: "lesson.ogg", audioSource: "external" }),
      neUrl,
    );

    await expect(findWorkingAudioUrl(recording, neUrl)).resolves.toBe(urlOf("intro-01.ogg"));
    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
      [urlOf("lesson.ogg"), "HEAD"],
      [urlOf("intro-01.ogg"), "HEAD"],
    ]);
  });

  it("finds the narration an older export declared without naming its file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response(null, { headers: { "content-type": "audio/webm" } }),
      ),
    );

    await expect(
      findWorkingAudioUrl(recordingWith({ audioSource: "external" }), neUrl),
    ).resolves.toBe(urlOf("intro-01.weba"));
  });

  it("asks nothing for a narration that is in memory, or that a lesson does not have", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      findWorkingAudioUrl(
        recordingWith({ audioBlob: new Blob(["take"]), audioFile: "lesson.ogg" }),
        neUrl,
      ),
    ).resolves.toBeNull();
    await expect(findWorkingAudioUrl(recordingWith({}), neUrl)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the bundled introduction lesson", () => {
  // The landing demo and /learn play public/lessons/introduction/introduction.ne.
  const directory = "public/lessons/introduction";
  const fileOnDisk = (url: string) =>
    `${directory}/${decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")}`;

  it("names a narration file that ships beside it, so the player's first request finds it", async () => {
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

    const resolved = withResolvedMediaUrls(recording, neUrl);

    // Its file is not named after the `.ne`, so it is probed: the first candidate is there,
    // and the player streams that URL as it is.
    await expect(findWorkingAudioUrl(resolved, neUrl)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      resolved.audioUrl,
      expect.objectContaining({ method: "HEAD" }),
    ]);

    const narration = await loadRecordingNarration(resolved);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(narration?.type).toBe("audio/ogg");
    expect(new TextDecoder().decode(await narration!.slice(0, 4).arrayBuffer())).toBe("OggS");
  });
});
