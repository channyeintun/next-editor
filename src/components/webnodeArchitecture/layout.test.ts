import { describe, expect, it } from "vite-plus/test";
import { FLOWS } from "./flows";
import {
  LINKS,
  PART_BOXES,
  findLink,
  pathData,
  polylineLength,
  routeKeyframes,
  routePoints,
  shortenEnd,
  travelMs,
  type Box,
  type Point,
} from "./layout";
import { PARTS, type PartId } from "./parts";
import { PLACED_FLOWS, stepTravelMs } from "./placement";

function isInside([x, y]: Point, box: Box): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

function isOnEdge(point: Point, box: Box): boolean {
  const [x, y] = point;
  const onSide = x === box.x || x === box.x + box.width;
  const onTopOrBottom = y === box.y || y === box.y + box.height;
  return isInside(point, box) && (onSide || onTopOrBottom);
}

describe("the webnode diagram's lines", () => {
  it("draws each link from the edge of one part to the edge of the other, in straight segments", () => {
    for (const link of LINKS) {
      const name = `${link.a}-${link.b}`;
      expect(isOnEdge(link.points[0], PART_BOXES[link.a]), `${name} starts on ${link.a}`).toBe(
        true,
      );
      expect(isOnEdge(link.points.at(-1)!, PART_BOXES[link.b]), `${name} ends on ${link.b}`).toBe(
        true,
      );
      for (let index = 1; index < link.points.length; index++) {
        const [fromX, fromY] = link.points[index - 1];
        const [toX, toY] = link.points[index];
        expect(fromX === toX || fromY === toY, `${name} segment ${index}`).toBe(true);
      }
    }
  });

  it("finds a link from either end, with its line turned to match", () => {
    expect(findLink("editor", "kernel")?.points).toEqual([
      [264, 148],
      [364, 148],
    ]);
    expect(findLink("kernel", "editor")?.points).toEqual([
      [364, 148],
      [264, 148],
    ]);
    expect(findLink("editor", "registry")).toBeNull();
  });

  it("joins two links inside the part between them", () => {
    // Out of the gateway's right side, in at its bottom: straight on, then a turn.
    expect(routePoints("server", ["gateway", "sw"])).toEqual([
      [704, 404],
      [604, 404],
      [484, 404],
      [484, 428],
      [484, 524],
    ]);
    expect(() => routePoints("editor", ["registry"])).toThrow(/no link/);
  });

  it("moves a mark at one speed: a keyframe at each corner, placed by distance", () => {
    const corner: Point[] = [
      [0, 0],
      [30, 0],
      [30, 10],
    ];

    expect(polylineLength(corner)).toBe(40);
    expect(routeKeyframes("turn", corner)).toBe(
      "@keyframes turn{0%{transform:translate(0px,0px)}75%{transform:translate(30px,0px)}100%{transform:translate(30px,10px)}}",
    );
    expect(pathData(corner)).toBe("M0 0 L30 0 L30 10");
  });

  it("stops an arrowhead short of the part and keeps a mark's travel within limits", () => {
    expect(
      shortenEnd(
        [
          [0, 0],
          [100, 0],
        ],
        7,
      ),
    ).toEqual([
      [0, 0],
      [93, 0],
    ]);
    // A hop between two neighbours is not a flash, and the longest way is not a wait.
    expect(travelMs(findLink("pm", "fs")!.points)).toBe(700);
    expect(travelMs(routePoints("preview", ["sw", "gateway", "server"]))).toBeLessThanOrEqual(2200);
  });
});

describe("the webnode flows on the diagram", () => {
  const moves = FLOWS.flatMap((flow) =>
    flow.steps.flatMap((step) => step.moves.map((move) => ({ flow, step, move }))),
  );

  it("sends every message along links that exist, with a name that fits each line", () => {
    for (const { flow, move } of moves) {
      let at: PartId = move.from;
      for (const hop of move.hops) {
        const found = findLink(at, hop.to);
        expect(found, `${flow.id}: ${at} to ${hop.to}`).not.toBeNull();
        expect(
          hop.label.length,
          `${flow.id}: "${hop.label}" on ${at}-${hop.to}`,
        ).toBeLessThanOrEqual(found!.link.label.maxChars);
        at = hop.to;
      }
    }
  });

  it("turns a message only inside the part it passes through", () => {
    for (const { flow, move } of moves) {
      const through = move.hops.map((hop) => hop.to);
      const route = routePoints(move.from, through);
      const linkPoints = new Set(LINKS.flatMap((link) => link.points.map(String)));
      const passed = through.slice(0, -1);
      for (const point of route) {
        if (linkPoints.has(String(point))) {
          continue;
        }
        expect(
          passed.some((part) => isInside(point, PART_BOXES[part])),
          `${flow.id}: corner ${String(point)}`,
        ).toBe(true);
      }
    }
  });

  it("uses every part and every link in some flow", () => {
    const usedParts = new Set(
      moves.flatMap(({ move }) => [move.from, ...move.hops.map((hop) => hop.to)]),
    );
    expect([...usedParts].sort()).toEqual(PARTS.map((part) => part.id).sort());

    const usedLinks = new Set<string>();
    for (const { move } of moves) {
      let at: PartId = move.from;
      for (const hop of move.hops) {
        const { link } = findLink(at, hop.to)!;
        usedLinks.add(`${link.a}-${link.b}`);
        at = hop.to;
      }
    }
    expect([...usedLinks].sort()).toEqual(LINKS.map((link) => `${link.a}-${link.b}`).sort());
  });

  it("gives each step one short caption of its own and at least one message", () => {
    for (const flow of FLOWS) {
      const titles = flow.steps.map((step) => step.title);
      expect(new Set(titles).size, `flow ${flow.id}`).toBe(titles.length);
      for (const step of flow.steps) {
        expect(step.moves.length, `messages of "${step.title}"`).toBeGreaterThan(0);
        expect(step.title).toMatch(/\.$/);
        expect(step.title.length, `length of "${step.title}"`).toBeLessThanOrEqual(80);
        expect(step.detail, `detail of "${step.title}"`).not.toBe("");
      }
    }
  });

  it("names one animation for each message and times a step by its slowest mark", () => {
    const names = PLACED_FLOWS.flat(2).map((move) => move.animation);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("wn-boot-0-0");

    // The preview flow's second step sends two messages at once.
    const request = FLOWS.findIndex((flow) => flow.id === "request");
    const [toKernel, toPreview] = PLACED_FLOWS[request][1];
    expect(stepTravelMs(request, 1)).toBe(Math.max(toKernel.travelMs, toPreview.travelMs));
    expect(toPreview.labels).toEqual([
      { text: "webnode:preview-port", at: findLink("editor", "preview")!.link.label },
    ]);
  });
});
