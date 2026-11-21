// The flows laid on the diagram: for each message of each step, the line it
// travels, the animation that moves its mark along it, and where its names are
// written. Worked out once, when the module loads.
import { FLOWS, type MessageKind, type Move } from "./flows";
import { findLink, routeKeyframes, routePoints, travelMs, type Link, type Point } from "./layout";
import type { PartId } from "./parts";

export interface PlacedLabel {
  text: string;
  at: Link["label"];
}

export interface PlacedMove {
  kind: MessageKind;
  /** The line the mark travels, start to end. */
  points: Point[];
  /** The parts the message leaves, passes and reaches. */
  parts: PartId[];
  /** The message's name on each link of the way. */
  labels: PlacedLabel[];
  /** The name of the CSS animation that moves the mark along `points`. */
  animation: string;
  travelMs: number;
}

function placeMove(move: Move, animation: string): PlacedMove {
  const through = move.hops.map((hop) => hop.to);
  const points = routePoints(move.from, through);
  const labels: PlacedLabel[] = [];
  let at = move.from;
  for (const hop of move.hops) {
    // routePoints has thrown already where two parts share no link.
    labels.push({ text: hop.label, at: findLink(at, hop.to)!.link.label });
    at = hop.to;
  }
  return {
    kind: move.kind,
    points,
    parts: [move.from, ...through],
    labels,
    animation,
    travelMs: travelMs(points),
  };
}

/** `PLACED_FLOWS[flow][step]` is the placed messages of that step. */
export const PLACED_FLOWS: PlacedMove[][][] = FLOWS.map((flow) =>
  flow.steps.map((step, stepIndex) =>
    step.moves.map((move, moveIndex) => placeMove(move, `wn-${flow.id}-${stepIndex}-${moveIndex}`)),
  ),
);

/** The `@keyframes` of every mark. */
export const FLOW_KEYFRAMES_CSS = PLACED_FLOWS.flat(2)
  .map((move) => routeKeyframes(move.animation, move.points))
  .join("\n");

/** How long the marks of a step travel: the slowest of them. */
export function stepTravelMs(flowIndex: number, stepIndex: number): number {
  return Math.max(0, ...PLACED_FLOWS[flowIndex][stepIndex].map((move) => move.travelMs));
}
