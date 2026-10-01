import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  POCKET_ONNX_RUNTIME_VERSION,
  customVoiceProfileOf,
  modalVoxCpm2BurmeseProfileOf,
  requireVoiceProfile,
  ttsRequestHash,
  type PocketVoiceProfile,
} from "./profiles";
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
  // hash the request had before the Pocket text-prep version existed.
  it("is unchanged by the Pocket text-prep version", async () => {
    const profile = modalVoxCpm2BurmeseProfileOf({ id: "voice-1", sampleSha256: "abc" });

    expect(
      await ttsRequestHash({ profile, speechText: "မင်္ဂလာပါ။", lexiconVersion: 1, seed: 42 }),
    ).toBe("fd4e90cdaaeb185a9d38e6b99c4086d20452231db164412357060df7fad51cfa");
  });
});
