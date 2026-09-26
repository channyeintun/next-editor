import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  POCKET_ONNX_RUNTIME_VERSION,
  customVoiceProfileOf,
  requireVoiceProfile,
  ttsRequestHash,
  type PocketVoiceProfile,
} from "./profiles";

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
});
