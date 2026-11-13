import { strToU8, Zip, ZipPassThrough, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getCachedDialogWav, putCachedDialogWav } from "../tts/dialogCache";
import { encodeWavPcm16 } from "../tts/wav";
import { importNarrationAudio, type NarrationAudioImportOptions } from "./audioImport";

type DecodeFlac = NonNullable<NarrationAudioImportOptions["decodeFlac"]>;

const hashOf = (digit: string) => digit.repeat(64);

/** A 220 Hz tone as a mono PCM16 WAV: a take a render can use. */
function voicedWav(durationMs = 300, sampleRate = 48_000, amplitude = 0.2): Uint8Array {
  const pcm = new Int16Array(Math.round((durationMs / 1000) * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude * 0x7fff);
  }
  return encodeWavPcm16(pcm, sampleRate);
}

const silentWav = () => encodeWavPcm16(new Int16Array(4800), 48_000);

function memoryCaches(put?: () => Promise<void>): Pick<CacheStorage, "open"> {
  const entries = new Map<string, Response>();
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    keys: async (url: string) =>
      entries.has(url) ? [new Request(`https://studio.test${url}`)] : [],
    put: put ?? (async (url: string, response: Response) => void entries.set(url, response)),
    delete: async (url: string) => entries.delete(url),
  };
  return { open: async () => cache as unknown as Cache };
}

const zipFile = (name: string, entries: Record<string, Uint8Array>, level: 0 | 6 = 0) =>
  new File([zipSync(entries, { level }) as Uint8Array<ArrayBuffer>], name);

beforeEach(() => {
  vi.stubGlobal("caches", memoryCaches());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importNarrationAudio", () => {
  it("files each take of a part under the request hash it is named by", async () => {
    const first = voicedWav(300);
    const second = voicedWav(500);
    const progress: number[] = [];

    const result = await importNarrationAudio(
      [
        zipFile("audio-0001.zip", {
          [`${hashOf("a")}.wav`]: first,
          [`${hashOf("b")}.wav`]: second,
        }),
      ],
      { onProgress: (takes) => progress.push(takes) },
    );

    expect(result).toEqual({
      imported: 2,
      alreadyCached: 0,
      ignored: 0,
      unusable: [],
      storageFailure: null,
    });
    expect(progress).toEqual([1, 2]);
    // The cache keeps the take as it came: the render prepares it on every build.
    expect((await getCachedDialogWav(hashOf("a")))?.wav).toEqual(first);
    expect(await getCachedDialogWav(hashOf("b"))).toEqual({ wav: second, hitFrameCap: false });
  });

  it("reads the parts inside a zip of a downloaded folder, deflated or stored", async () => {
    const part = zipSync({ [`${hashOf("c")}.wav`]: voicedWav() }, { level: 0 });

    const result = await importNarrationAudio([
      zipFile(
        "pack-2026-11-14.zip",
        {
          "pack-2026-11-14/audio-0001.zip": part,
          "pack-2026-11-14/requests.json": strToU8("{}"),
          [`pack-2026-11-14/${hashOf("d")}.wav`]: voicedWav(),
        },
        6,
      ),
    ]);

    expect(result).toMatchObject({ imported: 2, ignored: 1, unusable: [] });
    expect(await getCachedDialogWav(hashOf("c"))).not.toBeNull();
    expect(await getCachedDialogWav(hashOf("d"))).not.toBeNull();
  });

  it("decodes a FLAC take to the WAV the cache keeps", async () => {
    const decoded = voicedWav(400);
    const decodeFlac = vi.fn<DecodeFlac>(async () => decoded);
    const flac = strToU8("fLaC stand-in");

    const result = await importNarrationAudio(
      [zipFile("audio-0001.zip", { [`${hashOf("e")}.flac`]: flac })],
      { decodeFlac },
    );

    expect(result.imported).toBe(1);
    expect(decodeFlac).toHaveBeenCalledOnce();
    const [given, sampleRate] = decodeFlac.mock.calls[0];
    // Compared as numbers: the unzipped bytes are a typed array of another realm.
    expect([Array.from(given), sampleRate]).toEqual([Array.from(flac), 48_000]);
    expect((await getCachedDialogWav(hashOf("e")))?.wav).toEqual(decoded);
  });

  it("takes loose takes as well as zips", async () => {
    const result = await importNarrationAudio([
      new File([voicedWav() as Uint8Array<ArrayBuffer>], `${hashOf("f")}.wav`),
      new File(["{}"], "requests.json"),
    ]);

    expect(result).toMatchObject({ imported: 1, ignored: 1 });
  });

  it("keeps the take the browser already has, and does not decode the new one", async () => {
    const kept = voicedWav(300);
    await putCachedDialogWav(hashOf("a"), { wav: kept, hitFrameCap: false });
    const decodeFlac = vi.fn<DecodeFlac>(async () => voicedWav(900));

    const result = await importNarrationAudio(
      [zipFile("audio-0001.zip", { [`${hashOf("a")}.flac`]: strToU8("fLaC") })],
      { decodeFlac },
    );

    expect(result).toMatchObject({ imported: 0, alreadyCached: 1 });
    expect(decodeFlac).not.toHaveBeenCalled();
    expect((await getCachedDialogWav(hashOf("a")))?.wav).toEqual(kept);
  });

  it("replaces a kept take a render would throw away with the imported one", async () => {
    await putCachedDialogWav(hashOf("a"), { wav: silentWav(), hitFrameCap: false });
    const imported = voicedWav(500);

    const result = await importNarrationAudio([
      zipFile("audio-0001.zip", { [`${hashOf("a")}.wav`]: imported }),
    ]);

    expect(result).toMatchObject({ imported: 1, alreadyCached: 0 });
    expect((await getCachedDialogWav(hashOf("a")))?.wav).toEqual(imported);
  });

  // Finder's Compress and folder downloads write the sizes after each entry's
  // data. Split from the front, this take would end at the signature inside it.
  it("reads a streamed zip whose take holds a zip signature", async () => {
    const take = voicedWav(400);
    take.set([0x50, 0x4b, 0x07, 0x08], 2000);
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      chunks.push(chunk);
    });
    for (const digit of ["a", "b"]) {
      const entry = new ZipPassThrough(`folder/${hashOf(digit)}.wav`);
      zip.add(entry);
      entry.push(take, true);
    }
    zip.end();

    const result = await importNarrationAudio([
      new File(chunks as Uint8Array<ArrayBuffer>[], "folder.zip"),
    ]);

    expect(result).toMatchObject({ imported: 2, unusable: [] });
    expect((await getCachedDialogWav(hashOf("b")))?.wav).toEqual(take);
  });

  it("imports nothing, and says why, where the page has no Cache storage", async () => {
    vi.stubGlobal("caches", undefined);

    const result = await importNarrationAudio([
      zipFile("audio-0001.zip", { [`${hashOf("a")}.wav`]: voicedWav() }),
    ]);

    expect(result).toMatchObject({
      imported: 0,
      storageFailure: "Cache storage is not available in this page",
    });
  });

  it("reports a take a render could not use and keeps none of it", async () => {
    const decodeFlac = vi.fn<DecodeFlac>(async () => {
      throw new Error("expected mono 16-bit 48000 Hz FLAC, got 2 channel(s), 16-bit, 44100 Hz");
    });

    const result = await importNarrationAudio(
      [
        zipFile("audio-0001.zip", {
          [`${hashOf("a")}.wav`]: silentWav(),
          [`${hashOf("b")}.wav`]: voicedWav(300, 24_000),
          [`${hashOf("c")}.wav`]: strToU8("not audio at all"),
          [`${hashOf("d")}.flac`]: strToU8("fLaC"),
          [`${hashOf("e")}.wav`]: voicedWav(),
        }),
      ],
      { decodeFlac },
    );

    expect(result.imported).toBe(1);
    expect(result.unusable.map(({ name }) => name)).toEqual(
      ["a", "b", "c", "d"].map((digit) => `${hashOf(digit)}.${digit === "d" ? "flac" : "wav"}`),
    );
    expect(result.unusable[0].reason).toMatch(/silent/);
    expect(result.unusable[1].reason).toMatch(/24000/);
    expect(result.unusable[3].reason).toMatch(/44100 Hz/);
    for (const digit of ["a", "b", "c", "d"]) {
      expect(await getCachedDialogWav(hashOf(digit))).toBeNull();
    }
  });

  it("ignores files that are not named by a request hash", async () => {
    const result = await importNarrationAudio([
      zipFile("audio-0001.zip", {
        "notes.txt": strToU8("hello"),
        "ABC.wav": voicedWav(),
        [`../${hashOf("a")}.mp3`]: voicedWav(),
        "nested/": new Uint8Array(0),
      }),
    ]);

    expect(result).toMatchObject({ imported: 0, ignored: 3, unusable: [] });
  });

  // Finder's Compress puts a `._name` metadata file beside each file it zips.
  it("passes over the metadata files macOS adds to a zip", async () => {
    const part = zipSync({ [`${hashOf("a")}.wav`]: voicedWav() }, { level: 0 });

    const result = await importNarrationAudio([
      zipFile("pack.zip", {
        "pack/audio-0001.zip": part,
        "pack/._audio-0001.zip": strToU8("Mac OS X        resource fork"),
        [`__MACOSX/pack/._${hashOf("b")}.wav`]: strToU8("Mac OS X"),
        [`__MACOSX/pack/${hashOf("c")}.wav`]: strToU8("Mac OS X"),
      }),
      new File(["Mac OS X"], "._audio-0002.zip"),
    ]);

    expect(result).toMatchObject({ imported: 1, ignored: 4, unusable: [] });
  });

  it("does not open a zip inside a part's zip", async () => {
    const inner = zipSync({ [`${hashOf("a")}.wav`]: voicedWav() }, { level: 0 });
    const part = zipSync({ "deeper.zip": inner }, { level: 0 });

    const result = await importNarrationAudio([zipFile("folder.zip", { "audio-0001.zip": part })]);

    expect(result).toMatchObject({ imported: 0, ignored: 1 });
  });

  it("reports a file that is not a zip and goes on with the next", async () => {
    const result = await importNarrationAudio([
      zipFile("folder.zip", { "audio-0001.zip": strToU8("PK not a zip") }),
      zipFile("audio-0002.zip", { [`${hashOf("a")}.wav`]: voicedWav() }),
    ]);

    expect(result.imported).toBe(1);
    expect(result.unusable).toEqual([
      { name: "audio-0001.zip", reason: expect.stringMatching(/^not a readable zip/) },
    ]);
  });

  it("ends where the browser stops keeping takes, and says why", async () => {
    vi.stubGlobal(
      "caches",
      memoryCaches(async () => {
        throw new DOMException("Quota exceeded.", "QuotaExceededError");
      }),
    );
    const decodeFlac = vi.fn<DecodeFlac>(async () => voicedWav());

    const result = await importNarrationAudio(
      [
        zipFile("audio-0001.zip", {
          [`${hashOf("a")}.wav`]: voicedWav(),
          [`${hashOf("b")}.flac`]: strToU8("fLaC"),
        }),
        zipFile("audio-0002.zip", { [`${hashOf("c")}.flac`]: strToU8("fLaC") }),
      ],
      { decodeFlac },
    );

    expect(result).toMatchObject({ imported: 0, storageFailure: "Quota exceeded." });
    expect(decodeFlac).not.toHaveBeenCalled();
  });
});
