import type { WhiteboardElementJSON } from "../core/src/whiteboard";
import { createSeededRandom } from "./cadence";
import type { StudioWhiteboardAsset } from "./plan";

/**
 * Expand authored whiteboard asset specs into full Excalidraw element JSON
 * (docs/agent-lesson-production.md §2 "authored-asset format"). Seeds and
 * nonces derive from the plan seed + asset id, so applying the same plan twice
 * upserts byte-identical elements and the repeatability comparison holds.
 */

function hashId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const COMMON_ELEMENT_FIELDS = {
  angle: 0,
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null,
  roundness: null,
  isDeleted: false,
  boundElements: null,
  link: null,
  locked: false,
  version: 1,
} as const;

export function buildWhiteboardElement(
  asset: StudioWhiteboardAsset,
  planSeed: number,
): WhiteboardElementJSON {
  const random = createSeededRandom(planSeed ^ hashId(asset.id));
  const seed = Math.floor(random() * 2_000_000_000) + 1;
  const versionNonce = Math.floor(random() * 2_000_000_000) + 1;
  // A fixed timestamp: `updated` feeds Excalidraw bookkeeping only, and a
  // wall-clock value here would break byte-identical repeat renders.
  const updated = 1;

  const base = {
    ...COMMON_ELEMENT_FIELDS,
    id: asset.id,
    x: asset.x,
    y: asset.y,
    width: asset.width,
    height: asset.height,
    strokeColor: asset.strokeColor,
    backgroundColor: asset.backgroundColor,
    seed,
    versionNonce,
    updated,
  };

  if (asset.kind === "text") {
    const text = asset.text ?? "";
    return {
      ...base,
      type: "text",
      text,
      originalText: text,
      fontSize: asset.fontSize,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
      autoResize: true,
    };
  }

  return {
    ...base,
    type: asset.kind,
  };
}
