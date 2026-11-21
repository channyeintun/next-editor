// The webnode diagram: the parts in their origins, the lines between them, and
// the messages of one step. A message is a mark that travels its line, the
// line itself drawn heavier with an arrowhead, and its name written on it; a
// step that is not moving shows the same thing with the mark where it arrives.
import { MESSAGE_KINDS, type MessageKind } from "./flows";
import {
  COLUMN_CAPTIONS,
  LINKS,
  PART_BOXES,
  REGIONS,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  labelWidth,
  pathData,
  shortenEnd,
  type Region,
} from "./layout";
import { PARTS, type Part } from "./parts";
import type { PlacedLabel, PlacedMove } from "./placement";

const KIND_COLOR: Record<MessageKind, string> = {
  request: "var(--blue)",
  response: "var(--ink)",
  event: "var(--redline)",
  call: "var(--ink-soft)",
};

/**
 * A message's mark, drawn round the origin. Each kind has a shape of its own,
 * so the kinds are told apart without their colours.
 */
export function MarkShape({ kind }: { kind: MessageKind }) {
  const halo = { stroke: "var(--paper)", strokeWidth: 2 };
  switch (kind) {
    case "request":
      return <circle r={7.5} fill={KIND_COLOR.request} {...halo} />;
    case "response":
      return <polygon points="0,-9.5 9.5,0 0,9.5 -9.5,0" fill={KIND_COLOR.response} {...halo} />;
    case "event":
      return <polygon points="0,-9.5 9,6.5 -9,6.5" fill={KIND_COLOR.event} {...halo} />;
    case "call":
      return (
        <rect
          x={-6.5}
          y={-6.5}
          width={13}
          height={13}
          fill="var(--paper)"
          stroke={KIND_COLOR.call}
          strokeWidth={3}
        />
      );
  }
}

function RegionFrame({ region }: { region: Region }) {
  const { x, y, width, height } = region.box;
  if (region.inner) {
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={4}
          fill="none"
          stroke="var(--dashline)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <text
          x={region.titleAt.x}
          y={region.titleAt.y}
          fontFamily="var(--font-mono)"
          fontSize={10.5}
          fill="var(--ink-faint)"
        >
          {region.title}
        </text>
      </g>
    );
  }
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        fill="var(--paper-strong)"
        stroke="var(--blue)"
        strokeWidth={1.4}
      />
      <text
        x={region.titleAt.x}
        y={region.titleAt.y}
        fontFamily="var(--font-mono)"
        fontWeight={500}
        fontSize={12}
        fill="var(--ink)"
      >
        {region.title}
      </text>
      {region.subtitle && (
        <text x={region.titleAt.x} y={region.titleAt.y + 16} fontSize={11} fill="var(--ink-soft)">
          {region.subtitle}
        </text>
      )}
    </g>
  );
}

function PartBox({ part, tag, active }: { part: Part; tag: number; active: boolean }) {
  const { x, y, width, height } = PART_BOXES[part.id];
  const external = part.id === "registry";
  const stroke = active ? "var(--ink)" : external ? "var(--dashline)" : "var(--blue)";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        fill={external ? "var(--paper)" : "var(--blue-fill)"}
        stroke={stroke}
        strokeWidth={active ? 2.4 : external ? 1.4 : 1}
        strokeDasharray={external ? "5 4" : undefined}
      />
      <text
        x={x + 14}
        y={y + 24}
        fontFamily="var(--font-mono)"
        fontSize={13}
        fontWeight={500}
        fill="var(--ink)"
      >
        {part.title}
      </text>
      {part.lines.map((line, index) => (
        <text key={line} x={x + 14} y={y + 42 + index * 14} fontSize={11} fill="var(--ink-soft)">
          {line}
        </text>
      ))}
      <circle
        cx={x + width - 16}
        cy={y + 16}
        r={11}
        fill="var(--redline-fill)"
        stroke="var(--redline)"
        strokeWidth={1}
      />
      <text
        x={x + width - 16}
        y={y + 16}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill="var(--redline)"
      >
        {tag}
      </text>
    </g>
  );
}

const LABEL_HEIGHT = 16;

function LineLabel({ label, kind }: { label: PlacedLabel; kind: MessageKind }) {
  const width = labelWidth(label.text);
  const left = label.at.anchor === "middle" ? label.at.x - width / 2 : label.at.x;
  return (
    <g>
      <rect
        x={left}
        y={label.at.y - LABEL_HEIGHT / 2}
        width={width}
        height={LABEL_HEIGHT}
        rx={3}
        fill="var(--paper)"
        stroke={KIND_COLOR[kind]}
        strokeWidth={1}
      />
      <text
        x={left + width / 2}
        y={label.at.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill="var(--ink)"
      >
        {label.text}
      </text>
    </g>
  );
}

/** How far an arrowhead stops before the part its line reaches. */
const ARROW_GAP = 7;

export interface FlowDiagramProps {
  /** The messages of the step shown. Each names its own animation, so a new step's marks start anew. */
  moves: PlacedMove[];
  /** Whether the marks travel their lines; when not, each is drawn where it arrives. */
  moving: boolean;
  /** Whether a travelling mark runs or is held where it is. */
  playing: boolean;
}

export default function FlowDiagram({ moves, moving, playing }: FlowDiagramProps) {
  const activeParts = new Set(moves.flatMap((move) => move.parts));

  return (
    <svg
      className="wn-diagram"
      data-playing={playing}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      width="100%"
      role="img"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>The parts of webnode on their three origins, and the messages between them</title>
      <desc>
        The editor page, on the editor's origin, holds one MessagePort to the kernel. The kernel
        worker runs on the runtime origin with the preview gateway inside it; beside it are the
        process workers (pnpm, and node running the dev server) and the shared file system that the
        kernel and every process call. pnpm reaches the npm registry on the network. The preview
        iframe and its service worker are on a preview origin: the page talks to the editor and to
        its service worker, and the service worker and the page's WebSockets reach the gateway. The
        steps of the flow shown are listed under the diagram.
      </desc>

      <defs>
        <pattern id="wn-grid" width={28} height={28} patternUnits="userSpaceOnUse">
          <path
            d="M 28 0 L 0 0 0 28"
            fill="none"
            stroke="var(--grid-line)"
            strokeWidth={1}
            opacity={0.55}
          />
        </pattern>
        {MESSAGE_KINDS.map((kind) => (
          <marker
            key={kind}
            id={`wn-arrow-${kind}`}
            viewBox="0 0 10 10"
            refX={8}
            refY={5}
            markerWidth={5}
            markerHeight={5}
            orient="auto-start-reverse"
          >
            <path
              d="M2 1L8 5L2 9"
              fill="none"
              stroke={KIND_COLOR[kind]}
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        ))}
      </defs>

      <rect x={0} y={0} width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#wn-grid)" />

      {REGIONS.map((region) => (
        <RegionFrame key={region.id} region={region} />
      ))}
      {COLUMN_CAPTIONS.map((caption) => (
        <text
          key={caption.text}
          x={caption.x}
          y={caption.y}
          fontFamily="var(--font-mono)"
          fontSize={10.5}
          fill="var(--ink-faint)"
        >
          {caption.text}
        </text>
      ))}

      {LINKS.map((link) => (
        <path
          key={`${link.a}-${link.b}`}
          d={pathData(link.points)}
          fill="none"
          stroke="var(--dashline)"
          strokeWidth={1.2}
          strokeDasharray={link.external ? "4 4" : undefined}
        />
      ))}

      {/* Under the parts, so a line is seen to enter a part, not to cross it. */}
      {moves.map((move) => (
        <path
          key={move.animation}
          className="wn-route"
          d={pathData(shortenEnd(move.points, ARROW_GAP))}
          fill="none"
          stroke={KIND_COLOR[move.kind]}
          strokeWidth={2.4}
          strokeLinejoin="round"
          strokeDasharray={move.kind === "response" ? "7 4" : undefined}
          markerEnd={`url(#wn-arrow-${move.kind})`}
        />
      ))}

      {PARTS.map((part, index) => (
        <PartBox key={part.id} part={part} tag={index + 1} active={activeParts.has(part.id)} />
      ))}

      {moves.map((move) =>
        move.labels.map((label) => (
          <LineLabel key={`${move.animation}-${label.text}`} label={label} kind={move.kind} />
        )),
      )}

      {moves.map((move) => {
        const [x, y] = move.points.at(-1)!;
        return (
          <g
            key={move.animation}
            className="wn-mark"
            data-kind={move.kind}
            transform={`translate(${x} ${y})`}
            style={
              moving
                ? { animationName: move.animation, animationDuration: `${move.travelMs}ms` }
                : undefined
            }
          >
            <MarkShape kind={move.kind} />
          </g>
        );
      })}
    </svg>
  );
}
