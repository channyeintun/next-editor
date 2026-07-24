import type { WhiteboardElementJSON } from "../core/src/whiteboard";
import { createSeededRandom } from "./cadence";
import type { StudioWhiteboardAsset, StudioWhiteboardStroke } from "./plan";

/**
 * Expand authored whiteboard asset specs into full Excalidraw element JSON
 * (docs/agent-lesson-production.md §2 "authored-asset format"). Seeds and
 * nonces derive from the plan seed + asset id, so applying the same plan twice
 * upserts byte-identical elements and the repeatability comparison holds.
 *
 * An asset can also be built at a fraction of itself ({@link WhiteboardElementFrame}),
 * which is what turns an upsert into a drawing: shapes grow from their anchor
 * corner the way a drag does, text fills in a character at a time, and a
 * freedraw stroke reveals a prefix of its points. Everything progress-independent
 * — seed, nonce, the full stroke path — is generated first and then sliced, so
 * frame N+1 is always frame N plus more of the same element rather than a
 * re-rolled one (roughjs would otherwise redraw its sketch lines every frame).
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
} as const;

/**
 * Recorded step between draw frames. 100 ms is what human capture flushes at
 * while a stroke is in progress, and replay only animates the last 150 ms
 * before an event (replayState/whiteboard.ts), so a step above that would
 * stutter; 50 ms also keeps the live render — which sees the raw steps, with
 * no interpolation — reasonably smooth.
 */
export const WHITEBOARD_DRAW_FRAME_MS = 50;

/** One recorded step of a drawn upsert. */
export interface WhiteboardElementFrame {
  /** Fraction of the element drawn so far, in (0, 1]. */
  progress: number;
  /** Excalidraw element version — bumps once per frame of this element. */
  version: number;
}

export interface WhiteboardDrawFrame extends WhiteboardElementFrame {
  /** Index into the action's upserted assets: only one is drawn at a time. */
  assetIndex: number;
}

/**
 * Split a drawn `whiteboard.apply` into recorded steps. The budget is shared
 * across the upserted assets *in sequence* — a presenter draws one thing, then
 * the next — so an action that upserts nine boxes staggers them instead of
 * dropping all nine on one frame. Every asset gets at least one frame, so the
 * real duration is {@link whiteboardDrawDurationMs}, not always `drawMs`.
 */
export function planWhiteboardDrawFrames(
  assetCount: number,
  drawMs: number,
): WhiteboardDrawFrame[] {
  if (assetCount <= 0 || drawMs <= 0) {
    return [];
  }
  const budget = Math.max(assetCount, Math.round(drawMs / WHITEBOARD_DRAW_FRAME_MS));
  const perAsset = Math.max(1, Math.floor(budget / assetCount));
  const frames: WhiteboardDrawFrame[] = [];
  for (let assetIndex = 0; assetIndex < assetCount; assetIndex++) {
    for (let step = 0; step < perAsset; step++) {
      frames.push({ assetIndex, progress: (step + 1) / perAsset, version: step + 1 });
    }
  }
  return frames;
}

/**
 * How long a drawn apply keeps the Performer busy. The compiler models this as
 * busy time (script/compile.ts) — the Performer is strictly sequential, so
 * without it every following action starts late and fails the timing gate.
 */
export function whiteboardDrawDurationMs(assetCount: number, drawMs: number): number {
  return planWhiteboardDrawFrames(assetCount, drawMs).length * WHITEBOARD_DRAW_FRAME_MS;
}

type Point = [number, number];

/** Resample a polyline to evenly spaced points, ~1 per 6px of path length. */
function resample(corners: readonly Point[]): Point[] {
  const lengths = corners.slice(1).map(([x, y], index) => {
    const [px, py] = corners[index];
    return Math.hypot(x - px, y - py);
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const count = Math.min(120, Math.max(16, Math.round(total / 6)));

  const points: Point[] = [];
  for (let step = 0; step <= count; step++) {
    let remaining = (total * step) / count;
    let segment = 0;
    while (segment < lengths.length - 1 && remaining > lengths[segment]) {
      remaining -= lengths[segment];
      segment += 1;
    }
    const fraction = lengths[segment] > 0 ? remaining / lengths[segment] : 0;
    const [x0, y0] = corners[segment];
    const [x1, y1] = corners[segment + 1];
    points.push([x0 + (x1 - x0) * fraction, y0 + (y1 - y0) * fraction]);
  }
  return points;
}

/**
 * The hand in "hand-drawn": a slow sine sway (the arm) plus a little per-point
 * noise (the fingers). Amplitudes stay near a stroke width so the shape still
 * reads as the thing it annotates.
 */
function waver(points: Point[], random: () => number): Point[] {
  const phase = random() * Math.PI * 2;
  const frequency = 2.5 + random() * 2;
  const amplitude = 1.2 + random() * 1.3;
  return points.map(([x, y], index) => {
    const t = index / Math.max(1, points.length - 1);
    const sway = Math.sin(t * frequency * Math.PI * 2 + phase) * amplitude;
    return [
      x + sway * 0.35 + (random() - 0.5) * 0.8,
      y + sway + (random() - 0.5) * 0.8,
    ] satisfies Point;
  });
}

/** Corner path of each stroke preset, in box-local coordinates. */
function strokeCorners(stroke: StudioWhiteboardStroke, width: number, height: number): Point[] {
  switch (stroke) {
    case "underline":
      return [
        [0, height * 0.86],
        [width, height * 0.9],
      ];
    case "strike":
      return [
        [0, height * 0.52],
        [width, height * 0.48],
      ];
    case "check":
      return [
        [width * 0.08, height * 0.52],
        [width * 0.38, height * 0.88],
        [width * 0.96, height * 0.08],
      ];
    case "arrow-right":
      // Shaft, then back up for the top barb, back to the tip, then down —
      // one continuous motion, the way a quick arrow is actually scribbled.
      return [
        [0, height * 0.5],
        [width, height * 0.5],
        [width * 0.74, height * 0.24],
        [width, height * 0.5],
        [width * 0.74, height * 0.76],
      ];
    case "arrow-down":
      return [
        [width * 0.5, 0],
        [width * 0.5, height],
        [width * 0.24, height * 0.74],
        [width * 0.5, height],
        [width * 0.76, height * 0.74],
      ];
    case "circle": {
      // Starts at the left, sweeps a little past a full turn — a circled word
      // never closes exactly where it started.
      const corners: Point[] = [];
      const steps = 48;
      for (let step = 0; step <= steps; step++) {
        const angle = Math.PI + (step / steps) * Math.PI * 2.12;
        corners.push([
          width * 0.5 + Math.cos(angle) * width * 0.5,
          height * 0.5 + Math.sin(angle) * height * 0.5,
        ]);
      }
      return corners;
    }
  }
}

/**
 * Full stroke path for a freedraw asset, in coordinates relative to the first
 * point (Excalidraw's freedraw convention) plus the offset that first point
 * sits at inside the asset's box.
 */
function buildStrokePath(
  asset: StudioWhiteboardAsset,
  random: () => number,
): { points: Point[]; offsetX: number; offsetY: number } {
  const wavered = waver(resample(strokeCorners(asset.stroke, asset.width, asset.height)), random);
  const [originX, originY] = wavered[0];
  return {
    points: wavered.map(([x, y]) => [x - originX, y - originY] satisfies Point),
    offsetX: originX,
    offsetY: originY,
  };
}

export function buildWhiteboardElement(
  asset: StudioWhiteboardAsset,
  planSeed: number,
  frame?: WhiteboardElementFrame,
): WhiteboardElementJSON {
  const random = createSeededRandom(planSeed ^ hashId(asset.id));
  const seed = Math.floor(random() * 2_000_000_000) + 1;
  const versionNonce = Math.floor(random() * 2_000_000_000) + 1;
  // A fixed timestamp: `updated` feeds Excalidraw bookkeeping only, and a
  // wall-clock value here would break byte-identical repeat renders.
  const updated = 1;
  const progress = frame ? Math.min(1, Math.max(0, frame.progress)) : 1;

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
    version: frame?.version ?? 1,
  };

  if (asset.kind === "text") {
    // Text is typed, not drawn — a partial frame is a prefix of the string.
    // Width and height stay final so the surrounding layout never shifts.
    const full = asset.text ?? "";
    const text =
      progress >= 1 ? full : full.slice(0, Math.max(1, Math.ceil(full.length * progress)));
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

  if (asset.kind === "freedraw") {
    // The path is generated whole and then cut, so every frame is a prefix of
    // the same stroke — this is also the shape replay interpolates between
    // recorded steps to draw the stroke point by point.
    const { points, offsetX, offsetY } = buildStrokePath(asset, random);
    const drawn = points.slice(0, Math.max(2, Math.ceil(points.length * progress)));
    const xs = drawn.map(([x]) => x);
    const ys = drawn.map(([, y]) => y);
    return {
      ...base,
      type: "freedraw",
      x: asset.x + offsetX,
      y: asset.y + offsetY,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points: drawn,
      // Excalidraw ignores `pressures` entirely when it simulates them, which
      // is what its own freehand tool records for a mouse-drawn stroke.
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
    };
  }

  // Shapes grow from their anchor corner, the way dragging one out looks.
  return {
    ...base,
    type: asset.kind,
    width: progress >= 1 ? asset.width : Math.max(1, asset.width * progress),
    height: progress >= 1 ? asset.height : Math.max(1, asset.height * progress),
  };
}
