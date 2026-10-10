import { describe, expect, it } from "vite-plus/test";
import {
  collaborationSlidePayloadAssetId,
  decodeCollaborationSlidePayload,
  encodeCollaborationSlidePayload,
  hydrateCollaborationSlideManifest,
  normalizeCollaborationTeachingSlides,
  verifyCollaborationSlideAsset,
} from "./teachingSlides";
import { ASSET, slide } from "./teachingTestFixtures";

describe("collaboration teaching slides", () => {
  it("normalizes duplicate IDs and reuses payload bytes independently of slide identity", () => {
    const normalized = normalizeCollaborationTeachingSlides([
      slide("same", 2, "later"),
      slide("first", 0),
      slide("same", 1, "first occurrence by order"),
    ]);
    expect(normalized.map(({ slide: item }) => item.id)).toEqual(["first", "same"]);
    const payload = encodeCollaborationSlidePayload(normalized[0].slide);
    expect(
      encodeCollaborationSlidePayload(slide("same-payload", 99, normalized[0].slide.content)),
    ).toEqual(payload);
    expect(
      decodeCollaborationSlidePayload(payload, {
        id: "manifest-slide",
        contentType: "html",
        asset: { ...ASSET, size: payload.byteLength },
      }),
    ).toMatchObject({ id: "manifest-slide", order: 0, content: normalized[0].slide.content });
  });

  it("verifies hydrated slide bytes against their content-addressed manifest", async () => {
    const payload = encodeCollaborationSlidePayload(slide("source", 0));
    const manifest = {
      id: "manifest-slide",
      contentType: "html" as const,
      asset: {
        ...ASSET,
        id: await collaborationSlidePayloadAssetId(payload),
        size: payload.byteLength,
      },
    };

    const fromBytes = (bytes: Uint8Array) =>
      hydrateCollaborationSlideManifest(manifest, new Map(), async () => bytes);
    await expect(fromBytes(payload)).resolves.toMatchObject({
      id: "manifest-slide",
      content: "<h1>source</h1>",
    });
    const verifiedBytes = await verifyCollaborationSlideAsset(payload, manifest.asset);
    expect(
      [manifest.id, "reused-manifest"].map((id) =>
        decodeCollaborationSlidePayload(verifiedBytes, { ...manifest, id }),
      ),
    ).toMatchObject([
      { id: "manifest-slide", content: "<h1>source</h1>" },
      { id: "reused-manifest", content: "<h1>source</h1>" },
    ]);
    let downloads = 0;
    const cache = new Map<string, Promise<Uint8Array>>();
    const download = async () => {
      downloads += 1;
      return payload;
    };
    await expect(
      Promise.all([
        hydrateCollaborationSlideManifest(manifest, cache, download),
        hydrateCollaborationSlideManifest(
          { ...manifest, id: "cached-reused-manifest" },
          cache,
          download,
        ),
      ]),
    ).resolves.toMatchObject([
      { id: "manifest-slide", content: "<h1>source</h1>" },
      { id: "cached-reused-manifest", content: "<h1>source</h1>" },
    ]);
    expect(downloads).toBe(1);

    const tampered = payload.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(fromBytes(tampered)).rejects.toThrow(/digest/);
    await expect(fromBytes(payload.subarray(1))).rejects.toThrow(/size/);
  });
});
