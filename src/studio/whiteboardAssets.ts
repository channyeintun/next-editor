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

/** Excalidraw's hand-drawn font (Virgil) and line height: what every board label is set in. */
export const WHITEBOARD_TEXT_FONT_FAMILY = 1;
export const WHITEBOARD_TEXT_LINE_HEIGHT = 1.25;

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
 * How long a drawn apply keeps the Performer busy. planActionBusyMs (plan.ts)
 * counts it as busy time — the Performer is strictly sequential, so without it
 * every following action starts late and fails the timing gate.
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

/** Shaft from `from` to `to`, then both barbs — one continuous motion, as a quick arrow is scribbled. */
function arrowCorners(from: Point, to: Point, shaft: readonly Point[] = [from]): Point[] {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const reach = shaft
    .slice(1)
    .reduce(
      (sum, [x, y], index) => sum + Math.hypot(x - shaft[index][0], y - shaft[index][1]),
      Math.hypot(to[0] - shaft[shaft.length - 1][0], to[1] - shaft[shaft.length - 1][1]),
    );
  const barb = Math.min(26, Math.max(10, reach * 0.22));
  const barbAt = (side: 1 | -1): Point => [
    to[0] - Math.cos(angle + side * 0.5) * barb,
    to[1] - Math.sin(angle + side * 0.5) * barb,
  ];
  return [...shaft, to, barbAt(-1), to, barbAt(1)];
}

/** An arrow that bows from `from` to `to` around `control` (a quadratic curve), landing along the curve. */
function arcArrowCorners(from: Point, control: Point, to: Point): Point[] {
  const steps = 24;
  const shaft: Point[] = [];
  for (let step = 0; step < steps; step++) {
    const t = step / steps;
    const u = 1 - t;
    shaft.push([
      u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
      u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
    ]);
  }
  // The barbs follow the direction the curve arrives in, not the chord.
  return arrowCorners(control, to, shaft);
}

// A curly brace along a span: `along` runs 0–1 from one arm to the other,
// `out` 0–1 from the arms to the point.
const BRACE_PROFILE: readonly Point[] = [
  [0, 0],
  [0.03, 0.3],
  [0.08, 0.45],
  [0.42, 0.5],
  [0.47, 0.62],
  [0.5, 1],
  [0.53, 0.62],
  [0.58, 0.5],
  [0.92, 0.45],
  [0.97, 0.3],
  [1, 0],
];

/** Corner path of each stroke preset, in box-local coordinates. */
function strokeCorners(stroke: StudioWhiteboardStroke, width: number, height: number): Point[] {
  switch (stroke) {
    case "underline":
      return [
        [0, height * 0.86],
        [width, height * 0.9],
      ];
    case "double-underline":
      // Out along the first line, back along the second — the pen never lifts.
      return [
        [0, height * 0.74],
        [width, height * 0.77],
        [width * 0.985, height * 0.9],
        [width * 0.03, height * 0.93],
      ];
    case "wavy": {
      const amplitude = Math.min(5, Math.max(2.5, height * 0.12));
      const waves = Math.max(2, Math.round(width / 22));
      const steps = waves * 8;
      const corners: Point[] = [];
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        corners.push([width * t, height * 0.84 + Math.sin(t * waves * Math.PI * 2) * amplitude]);
      }
      return corners;
    }
    case "strike":
      return [
        [0, height * 0.52],
        [width, height * 0.48],
      ];
    case "scribble": {
      // A fast zigzag across the whole box: crossing something out for good.
      const teeth = Math.max(3, Math.round(width / Math.max(14, height * 0.6)));
      const corners: Point[] = [];
      for (let tooth = 0; tooth <= teeth; tooth++) {
        corners.push([(width * tooth) / teeth, tooth % 2 === 0 ? height * 0.9 : height * 0.1]);
      }
      return corners;
    }
    case "check":
      return [
        [width * 0.08, height * 0.52],
        [width * 0.38, height * 0.88],
        [width * 0.96, height * 0.08],
      ];
    case "box":
      // Round the box once and run a little past the corner it started from —
      // a looser frame than a rectangle, for "these belong together".
      return [
        [0, height * 0.04],
        [width, 0],
        [width * 0.995, height],
        [width * 0.01, height * 0.985],
        [0, -height * 0.04],
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
    case "arrow-left":
      return [
        [width, height * 0.5],
        [0, height * 0.5],
        [width * 0.26, height * 0.24],
        [0, height * 0.5],
        [width * 0.26, height * 0.76],
      ];
    case "arrow-down":
      return [
        [width * 0.5, 0],
        [width * 0.5, height],
        [width * 0.24, height * 0.74],
        [width * 0.5, height],
        [width * 0.76, height * 0.74],
      ];
    case "arrow-up":
      return [
        [width * 0.5, height],
        [width * 0.5, 0],
        [width * 0.24, height * 0.26],
        [width * 0.5, 0],
        [width * 0.76, height * 0.26],
      ];
    case "arrow-up-right":
      return arrowCorners([0, height], [width, 0]);
    case "arrow-down-right":
      return arrowCorners([0, 0], [width, height]);
    case "arrow-up-left":
      return arrowCorners([width, height], [0, 0]);
    case "arrow-down-left":
      return arrowCorners([width, 0], [0, height]);
    case "arrow-arc-right":
      // Up and over: leaves the bottom-left corner, tops out on the box's top
      // edge, lands on the bottom-right corner.
      return arcArrowCorners([0, height], [width * 0.5, -height], [width, height]);
    case "arrow-arc-left":
      // Back underneath: leaves the top-right corner, dips to the bottom edge,
      // lands on the top-left corner.
      return arcArrowCorners([width, 0], [width * 0.5, height * 2], [0, 0]);
    case "brace-right":
      return BRACE_PROFILE.map(([along, out]) => [out * width, along * height] satisfies Point);
    case "brace-left":
      return BRACE_PROFILE.map(
        ([along, out]) => [(1 - out) * width, along * height] satisfies Point,
      );
    case "brace-down":
      return BRACE_PROFILE.map(([along, out]) => [along * width, out * height] satisfies Point);
    case "brace-up":
      return BRACE_PROFILE.map(
        ([along, out]) => [along * width, (1 - out) * height] satisfies Point,
      );
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

/** The seeded values an asset's element is built from, in the order they are drawn. */
function assetSeeds(asset: StudioWhiteboardAsset, planSeed: number) {
  const random = createSeededRandom(planSeed ^ hashId(asset.id));
  const seed = Math.floor(random() * 2_000_000_000) + 1;
  const versionNonce = Math.floor(random() * 2_000_000_000) + 1;
  return { random, seed, versionNonce };
}

/** How many of a stroke's points are on the board at `progress`. */
function drawnPointCount(pointCount: number, progress: number): number {
  return Math.min(pointCount, Math.max(2, Math.ceil(pointCount * progress)));
}

/** The text of a `text` asset typed so far at `progress`. */
export function whiteboardTextAt(asset: StudioWhiteboardAsset, progress: number): string {
  const full = asset.text ?? "";
  return progress >= 1 ? full : full.slice(0, Math.max(1, Math.ceil(full.length * progress)));
}

/**
 * Where the pen tip is, in scene coordinates, once `progress` of a `freedraw`
 * asset's stroke is drawn — the last point {@link buildWhiteboardElement}
 * puts on the board at that progress, or the stroke's first point at 0.
 */
export function whiteboardStrokeTip(
  asset: StudioWhiteboardAsset,
  planSeed: number,
  progress: number,
): { x: number; y: number } {
  const { points, offsetX, offsetY } = buildStrokePath(asset, assetSeeds(asset, planSeed).random);
  const drawn = progress > 0 ? drawnPointCount(points.length, Math.min(1, progress)) : 1;
  const [x, y] = points[drawn - 1];
  return { x: asset.x + offsetX + x, y: asset.y + offsetY + y };
}

export function buildWhiteboardElement(
  asset: StudioWhiteboardAsset,
  planSeed: number,
  frame?: WhiteboardElementFrame,
): WhiteboardElementJSON {
  const { random, seed, versionNonce } = assetSeeds(asset, planSeed);
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
    const text = whiteboardTextAt(asset, progress);
    return {
      ...base,
      type: "text",
      text,
      originalText: text,
      fontSize: asset.fontSize,
      fontFamily: WHITEBOARD_TEXT_FONT_FAMILY,
      textAlign: asset.align,
      verticalAlign: "top",
      containerId: null,
      lineHeight: WHITEBOARD_TEXT_LINE_HEIGHT,
      autoResize: true,
    };
  }

  if (asset.kind === "freedraw") {
    // The path is generated whole and then cut, so every frame is a prefix of
    // the same stroke — this is also the shape replay interpolates between
    // recorded steps to draw the stroke point by point.
    const { points, offsetX, offsetY } = buildStrokePath(asset, random);
    const drawn = points.slice(0, drawnPointCount(points.length, progress));
    const xs = drawn.map(([x]) => x);
    const ys = drawn.map(([, y]) => y);
    return {
      ...base,
      type: "freedraw",
      x: asset.x + offsetX,
      y: asset.y + offsetY,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      // Always the thin pen. Excalidraw's widths are 1 thin / 2 bold / 4 extra
      // bold, and freedraw renders heavier than a shape outline at the same
      // number — simulated pressure widens the middle of every stroke. At 2 the
      // annotations read as fat marker blobs next to the boxes they annotate,
      // so this is fixed at 1 rather than left to the author.
      strokeWidth: 1,
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
    strokeStyle: asset.strokeStyle,
    fillStyle: asset.fillStyle,
    // Excalidraw's own corner rule per shape: a rectangle's radius adapts to
    // its size (3), a diamond's is proportional (2). An ellipse has no corners.
    roundness:
      asset.rounded && asset.kind !== "ellipse" ? { type: asset.kind === "diamond" ? 2 : 3 } : null,
  };
}
