import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  POCKET_ONNX_RUNTIME_VERSION,
  athanLabProfileOf,
  customVoiceProfileOf,
  modalVoxCpm2BurmeseProfileOf,
  requireVoiceProfile,
  ttsRequestHash,
  type PocketVoiceProfile,
} from "./profiles";
import { ATHANLAB_TEXT_PREP_VERSION } from "./athanlab/textPrep";
import { POCKET_ENGINE_VERSION } from "./pocket/engineVersion";
import { POCKET_TEXT_PREP_VERSION } from "./pocket/textPrep";

describe("pocket voice profiles", () => {
  // A runtime bump changes the synthesized samples, so a stale constant would
  // replay audio cached under the previous runtime as if it were current.
  it("pin the onnxruntime-web release that is installed", () => {
    // Resolve from the project root (vitest cwd): the package's `exports` map
    // does not expose its package.json.
    const { version } = JSON.parse(
      readFileSync(resolve(process.cwd(), "node_modules/onnxruntime-web/package.json"), "utf8"),
    ) as { version: string };

    expect(POCKET_ONNX_RUNTIME_VERSION).toBe(version);
    expect(requireVoiceProfile("pocket-alba-v1")).toMatchObject({ onnxRuntimeVersion: version });
    expect(customVoiceProfileOf({ id: "v1", sampleSha256: "abc" })).toMatchObject({
      onnxRuntimeVersion: version,
    });
  });

  it("key cached dialogs on the runtime release", async () => {
    const profile = requireVoiceProfile("pocket-alba-v1") as PocketVoiceProfile;
    const request = { profile, speechText: "Hello there.", lexiconVersion: 1, seed: 7 };

    expect(await ttsRequestHash(request)).not.toBe(
      await ttsRequestHash({ ...request, profile: { ...profile, onnxRuntimeVersion: "1.20.1" } }),
    );
  });

  // A profile's fields are its dialogs' cache key: these change only on purpose.
  it("keep the request hash of the built-in and cloned voices", async () => {
    const request = { speechText: "Hello there.", lexiconVersion: 1, seed: 7 };

    expect(
      await ttsRequestHash({ ...request, profile: requireVoiceProfile("pocket-alba-v1") }),
    ).toBe("25a1370ff71ca8b458b37a37b591b0cbac8653d7c8526c23b8fab39f4b356905");
    expect(
      await ttsRequestHash({
        ...request,
        profile: customVoiceProfileOf({ id: "voice-1", sampleSha256: "abc" }),
      }),
    ).toBe("8707f593b995068279b04a805d271b3cb73e367107b47db07c49e71cae2c420a");
  });

  // Engine v2 decodes the trailing latents of a capped chunk, so the v1 keys
  // (these exact requests before the bump) must no longer hit the cache.
  it("key cached dialogs on the engine version", async () => {
    const request = { speechText: "Hello there.", lexiconVersion: 1, seed: 7 };

    expect(POCKET_ENGINE_VERSION).toBe(2);
    expect(
      await ttsRequestHash({ ...request, profile: requireVoiceProfile("pocket-alba-v1") }),
    ).not.toBe("24d821ef9a86b4b27f1598a67e0a9c65e5b5211a90a6d406475e5fd95c89f705");
    expect(
      await ttsRequestHash({
        ...request,
        profile: customVoiceProfileOf({ id: "voice-1", sampleSha256: "abc" }),
      }),
    ).not.toBe("a726b11d89a27b1e1287bd09efa1e791b4e43bf392870d572bf5b705774809b9");
  });

  // Text prep v2 changed the prompt for the same speech text, so the v1 key
  // (this exact request before the bump) must no longer hit the cache.
  it("keys cached dialogs on the text-prep version", async () => {
    const profile = requireVoiceProfile("pocket-alba-v1");
    const request = { profile, speechText: "Hello there.", lexiconVersion: 1, seed: 7 };

    expect(POCKET_TEXT_PREP_VERSION).toBe(2);
    expect(await ttsRequestHash(request)).not.toBe(
      "deb29208a38a943ca50333da096a7a28003664dc64ee749aa00f54d35f933ce6",
    );
  });
});

describe("voxcpm2 request hash", () => {
  // Pocket-only cache changes must not re-key paid Modal takes: this is the
  // hash the request had before the Pocket text-prep and engine versions existed.
  it("is unchanged by the Pocket text-prep version", async () => {
    const profile = modalVoxCpm2BurmeseProfileOf({ id: "voice-1", sampleSha256: "abc" });

    expect(
      await ttsRequestHash({ profile, speechText: "မင်္ဂလာပါ။", lexiconVersion: 1, seed: 42 }),
    ).toBe("fd4e90cdaaeb185a9d38e6b99c4086d20452231db164412357060df7fad51cfa");
  });

  it("keeps the request hash of the registry profile", async () => {
    expect(
      await ttsRequestHash({
        profile: requireVoiceProfile("modal-voxcpm2-burmese-v1"),
        speechText: "မင်္ဂလာပါ။",
        lexiconVersion: 1,
        seed: 42,
      }),
    ).toBe("0e897f1c6cd990a2d466568a16bfefeedc226284894bc7292ffa4fa864ed3a41");
  });
});

describe("athanlab voice profiles", () => {
  it("pin the voice and every server-fixed request setting", () => {
    expect(athanLabProfileOf("voice_01")).toEqual({
      id: "athanlab-voice_01",
      providerId: "athanlab",
      voiceId: "voice_01",
      outputFormat: "wav",
      numberMode: "smart",
      textPrepVersion: ATHANLAB_TEXT_PREP_VERSION,
      sampleRate: 48000,
      mimeType: "audio/wav",
    });
  });

  it("are not in the static registry", () => {
    expect(() => requireVoiceProfile("athanlab-voice_01")).toThrow(/Unknown voice profile/);
  });

  // Each take is bought: only a change that alters what AthanLab is asked to
  // speak (or who speaks it) may re-key a cached dialog.
  it("key cached dialogs on the voice and the text-prep version", async () => {
    const profile = athanLabProfileOf("voice_01");
    const request = { profile, speechText: "မင်္ဂလာပါ။", lexiconVersion: 1, seed: 0 };
    const hash = await ttsRequestHash(request);

    // Pinned: a change to this hash makes every user buy their cached takes again.
    expect(hash).toBe("cc61e779445fa636f0a434cc636a45593b51c784bbd8487254a90c825cbf967f");
    expect(await ttsRequestHash({ ...request, profile: athanLabProfileOf("voice_01") })).toBe(hash);
    expect(await ttsRequestHash({ ...request, profile: athanLabProfileOf("voice_02") })).not.toBe(
      hash,
    );
    expect(
      await ttsRequestHash({
        ...request,
        profile: { ...profile, textPrepVersion: 2 as unknown as 1 },
      }),
    ).not.toBe(hash);
  });
});
