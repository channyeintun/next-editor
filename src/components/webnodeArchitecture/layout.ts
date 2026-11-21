// Where the webnode diagram draws each part and the lines between them, and
// the line a message travels from one part to another. Pure geometry: nothing
// here reads the DOM, so the same numbers draw the diagram, move the marks
// (as CSS keyframes) and are checked by the tests.
import type { PartId } from "./parts";

export type Point = readonly [x: number, y: number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const VIEW_WIDTH = 1200;
export const VIEW_HEIGHT = 632;

const COLUMN_WIDTH = 240;
const ROW_HEIGHT = 80;
const [COLUMN_A, COLUMN_B, COLUMN_C, COLUMN_D] = [24, 364, 704, 1034];
const [ROW_1, ROW_2, ROW_3, ROW_4] = [108, 228, 348, 524];

function box(x: number, y: number, width = COLUMN_WIDTH, height = ROW_HEIGHT): Box {
  return { x, y, width, height };
}

export const PART_BOXES: Record<PartId, Box> = {
  editor: box(COLUMN_A, ROW_1),
  // The kernel is two rows tall: it is what every process and the editor talk to.
  kernel: box(COLUMN_B, ROW_1, COLUMN_WIDTH, ROW_2 + ROW_HEIGHT - ROW_1),
  gateway: box(COLUMN_B, ROW_3),
  pm: box(COLUMN_C, ROW_1),
  fs: box(COLUMN_C, ROW_2),
  server: box(COLUMN_C, ROW_3),
  preview: box(COLUMN_A, ROW_4),
  sw: box(COLUMN_B, ROW_4),
  registry: box(COLUMN_D, ROW_1, 150),
};

/** An area the diagram draws round the parts that share an origin or a worker. */
export interface Region {
  id: string;
  box: Box;
  title: string;
  /** A second, quieter line under the title. */
  subtitle?: string;
  /** Where the title is written: clear of every line that enters the area. */
  titleAt: { x: number; y: number };
  /** A thinner frame, for a worker inside an origin. */
  inner?: boolean;
}

export const REGIONS: Region[] = [
  {
    id: "editor-origin",
    box: { x: 8, y: 56, width: 272, height: 148 },
    title: "EDITOR ORIGIN",
    subtitle: "the editor's own site",
    titleAt: { x: 20, y: 76 },
  },
  {
    id: "runtime-origin",
    box: { x: 336, y: 28, width: 624, height: 420 },
    title: "RUNTIME ORIGIN · runtime.<host>",
    subtitle: "a hidden iframe starts the kernel worker; every process runs here",
    titleAt: { x: 348, y: 48 },
  },
  {
    id: "kernel-worker",
    box: { x: 350, y: 78, width: 268, height: 362 },
    title: "kernel worker",
    titleAt: { x: 362, y: 95 },
    inner: true,
  },
  {
    id: "preview-origin",
    // Wide enough to write its title beside the parts: lines come in from above.
    box: { x: 8, y: 480, width: 952, height: 140 },
    title: "PREVIEW ORIGIN · <session>-<port>.<host>",
    subtitle: "an origin of its own for each session and port",
    titleAt: { x: 632, y: 548 },
  },
];

/** Labels that stand over a column of parts without a frame. */
export const COLUMN_CAPTIONS: { x: number; y: number; text: string }[] = [
  { x: COLUMN_C, y: 96, text: "process workers · one per process" },
  { x: COLUMN_D, y: 96, text: "the network" },
];

/** A line between two parts: a channel messages travel on, in either direction. */
export interface Link {
  a: PartId;
  b: PartId;
  /** From `a` to `b`, edge to edge, in horizontal and vertical segments. */
  points: Point[];
  /** Where the name of a message on this line is written, and how long it may be. */
  label: { x: number; y: number; anchor: "middle" | "start"; maxChars: number };
  /** A call out to the network, drawn dashed. */
  external?: boolean;
}

export const LINKS: Link[] = [
  {
    a: "editor",
    b: "kernel",
    points: [
      [264, 148],
      [364, 148],
    ],
    label: { x: 314, y: 148, anchor: "middle", maxChars: 14 },
  },
  {
    a: "kernel",
    b: "pm",
    points: [
      [604, 132],
      [704, 132],
    ],
    label: { x: 654, y: 132, anchor: "middle", maxChars: 14 },
  },
  {
    a: "kernel",
    b: "fs",
    points: [
      [604, 268],
      [704, 268],
    ],
    label: { x: 654, y: 268, anchor: "middle", maxChars: 14 },
  },
  {
    a: "kernel",
    b: "server",
    points: [
      [604, 292],
      [654, 292],
      [654, 372],
      [704, 372],
    ],
    label: { x: 654, y: 332, anchor: "middle", maxChars: 14 },
  },
  {
    a: "gateway",
    b: "server",
    points: [
      [604, 404],
      [704, 404],
    ],
    label: { x: 654, y: 404, anchor: "middle", maxChars: 14 },
  },
  {
    a: "pm",
    b: "fs",
    points: [
      [824, 188],
      [824, 228],
    ],
    label: { x: 836, y: 208, anchor: "start", maxChars: 14 },
  },
  {
    a: "server",
    b: "fs",
    points: [
      [824, 348],
      [824, 308],
    ],
    label: { x: 836, y: 328, anchor: "start", maxChars: 14 },
  },
  {
    a: "pm",
    b: "registry",
    points: [
      [944, 148],
      [1034, 148],
    ],
    label: { x: 989, y: 148, anchor: "middle", maxChars: 12 },
    external: true,
  },
  {
    a: "gateway",
    b: "sw",
    points: [
      [484, 428],
      [484, 524],
    ],
    label: { x: 496, y: 464, anchor: "start", maxChars: 16 },
  },
  {
    a: "preview",
    b: "sw",
    points: [
      [264, 564],
      [364, 564],
    ],
    label: { x: 314, y: 564, anchor: "middle", maxChars: 14 },
  },
  {
    a: "editor",
    b: "preview",
    points: [
      [104, 188],
      [104, 524],
    ],
    label: { x: 104, y: 356, anchor: "middle", maxChars: 24 },
  },
  {
    a: "preview",
    b: "gateway",
    points: [
      [204, 524],
      [204, 388],
      [364, 388],
    ],
    label: { x: 284, y: 388, anchor: "middle", maxChars: 22 },
  },
];

/** The link between two parts and its line from `from` to `to`, or null when they share none. */
export function findLink(from: PartId, to: PartId): { link: Link; points: Point[] } | null {
  for (const link of LINKS) {
    if (link.a === from && link.b === to) {
      return { link, points: link.points };
    }
    if (link.a === to && link.b === from) {
      return { link, points: [...link.points].reverse() };
    }
  }
  return null;
}

const samePoint = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

/**
 * The line a message travels from `from` through each part of `through`: the
 * links' own lines, joined inside the part between two links by going straight
 * on and then turning, so the mark is seen to pass through that part.
 */
export function routePoints(from: PartId, through: readonly PartId[]): Point[] {
  const route: Point[] = [];
  let at = from;
  for (const next of through) {
    const found = findLink(at, next);
    if (!found) {
      throw new Error(`webnode diagram: no link between "${at}" and "${next}"`);
    }
    const [start] = found.points;
    const last = route.at(-1);
    if (last && !samePoint(last, start)) {
      const before = route.at(-2) ?? last;
      const corner: Point = before[1] === last[1] ? [start[0], last[1]] : [last[0], start[1]];
      if (!samePoint(corner, last) && !samePoint(corner, start)) {
        route.push(corner);
      }
    }
    for (const point of found.points) {
      if (!route.at(-1) || !samePoint(route.at(-1)!, point)) {
        route.push(point);
      }
    }
    at = next;
  }
  return route;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function polylineLength(points: readonly Point[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

/** `points` as SVG path data. */
export function pathData(points: readonly Point[]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
}

/** `points` with the last one pulled back by `by`, so an arrowhead stops short of the part. */
export function shortenEnd(points: readonly Point[], by: number): Point[] {
  const end = points.at(-1);
  const before = points.at(-2);
  if (!end || !before) {
    return [...points];
  }
  const length = distance(before, end);
  if (length <= by) {
    return [...points];
  }
  const keep = (length - by) / length;
  return [
    ...points.slice(0, -1),
    [before[0] + (end[0] - before[0]) * keep, before[1] + (end[1] - before[1]) * keep],
  ];
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The CSS animation that moves a mark along `points` at one speed: a keyframe
 * at each corner, placed by how far along the line the corner is.
 */
export function routeKeyframes(name: string, points: readonly Point[]): string {
  const total = polylineLength(points);
  let travelled = 0;
  const frames = points.map(([x, y], index) => {
    if (index > 0) {
      travelled += distance(points[index - 1], points[index]);
    }
    const last = index === points.length - 1;
    const percent = last || total === 0 ? 100 : round((travelled / total) * 100);
    return `${index === 0 ? 0 : percent}%{transform:translate(${x}px,${y}px)}`;
  });
  return `@keyframes ${name}{${frames.join("")}}`;
}

/** Pixels of the diagram a mark crosses in a millisecond. */
const MARK_SPEED = 0.26;
const MIN_TRAVEL_MS = 700;
const MAX_TRAVEL_MS = 2200;

/** How long a mark takes along `points`: one speed, within limits the eye can follow. */
export function travelMs(points: readonly Point[]): number {
  const ms = polylineLength(points) / MARK_SPEED;
  return Math.round(Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, ms)));
}

/** The width of a message name written on a line, in the diagram's units. */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * 6.05) + 10;
}
