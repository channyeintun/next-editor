// The flows section of the webnode sheet: pick a flow, watch its messages
// cross the diagram one step at a time, and read the same steps as a list.
//
// It moves by itself, so it can be stopped (WCAG 2.2.2): Pause holds a mark
// where it is, and Back and Next show a step without motion. Under
// prefers-reduced-motion nothing travels and nothing advances until Play is
// pressed, and then the steps only change, each drawn where its message ends.
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import FlowDiagram, { MarkShape } from "./FlowDiagram";
import { FLOWS, MESSAGE_KIND_LABELS, MESSAGE_KINDS, type MessageKind } from "./flows";
import { FLOW_KEYFRAMES_CSS, PLACED_FLOWS, stepTravelMs } from "./placement";
import Prose from "./Prose";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** How long a step stays once its marks have arrived, before the next begins. */
export const STEP_DWELL_MS = 2400;

export const flowPlayerStyles = `
.arch-page .flows{ padding:24px 32px 0; }
.arch-page .flow-picker, .arch-page .flow-controls{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.arch-page .flows button{
  font-family:var(--font-mono); font-size:12px; line-height:1; color:var(--ink);
  background:transparent; border:1px solid var(--blue); border-radius:3px;
  min-height:32px; padding:0 12px; cursor:pointer;
  display:inline-flex; align-items:center; gap:6px;
}
.arch-page .flows button:hover{ background:var(--blue-fill); }
.arch-page .flow-picker button[aria-pressed="true"]{
  background:var(--blue-fill); border-color:var(--ink); box-shadow:inset 0 -3px 0 var(--ink); font-weight:600;
}
.arch-page .flow-summary{ font-size:14px; line-height:1.5; color:var(--ink-soft); margin:12px 0 14px; max-width:80ch; }
.arch-page .flow-caption{
  display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline;
  margin:12px 0 0; min-height:3em; font-size:14px; line-height:1.5; color:var(--ink);
}
.arch-page .flow-caption .count{ font-family:var(--font-mono); font-size:12px; color:var(--ink-soft); font-variant-numeric:tabular-nums; }
.arch-page .flow-kind{
  display:inline-flex; align-items:center; gap:5px; font-family:var(--font-mono); font-size:11px;
  color:var(--ink-soft); border:1px solid var(--grid-line); border-radius:3px; padding:1px 6px;
}
.arch-page .flow-kind svg, .arch-page .legend-item svg{ width:14px; height:14px; flex:none; }
.arch-page .steps{ padding:22px 32px 26px; border-bottom:1px solid var(--grid-line); }
.arch-page .steps h3{
  font-family:var(--font-mono); font-size:12px; font-weight:500; letter-spacing:.04em;
  color:var(--ink-soft); margin:0 0 12px;
}
.arch-page .steps ol{ margin:0; padding:0; list-style:none; display:grid; gap:4px; }
.arch-page .steps li{
  display:flex; gap:10px; align-items:baseline; font-size:13px; line-height:1.5;
  padding:5px 10px; border-left:3px solid transparent;
}
.arch-page .steps li[aria-current="step"]{ border-left-color:var(--redline); background:var(--paper-strong); }
.arch-page .steps .n{ font-family:var(--font-mono); color:var(--redline); font-size:12px; flex:none; width:1.6em; }
.arch-page .steps b{ font-weight:500; color:var(--ink); }
.arch-page .steps .d{ color:var(--ink-soft); }
.arch-page .diagram-wrap svg.wn-diagram{ min-width:960px; }
.arch-page .wn-mark{ animation-timing-function:linear; animation-fill-mode:both; }
.arch-page .wn-diagram[data-playing="false"] .wn-mark{ animation-play-state:paused; }
@media (prefers-reduced-motion: reduce){
  .arch-page .wn-mark{ animation:none !important; }
}
@media (max-width: 640px){
  .arch-page .flows{ padding-left:18px; padding-right:18px; }
  .arch-page .steps{ padding-left:18px; padding-right:18px; }
}
${FLOW_KEYFRAMES_CSS}
`;

/** A message kind's mark beside its name: the key to the diagram's shapes. */
function KindKey({ kind }: { kind: MessageKind }) {
  return (
    <>
      <svg viewBox="-11 -11 22 22" aria-hidden="true">
        <MarkShape kind={kind} />
      </svg>
      {MESSAGE_KIND_LABELS[kind]}
    </>
  );
}

export default function FlowPlayer() {
  const reducedMotion = usePrefersReducedMotion();
  const [flowIndex, setFlowIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(!reducedMotion);
  // A settled step is drawn with its marks where they arrive: one the visitor
  // stepped to by hand. A step the player reached itself travels.
  const [settled, setSettled] = useState(reducedMotion);

  const flow = FLOWS[flowIndex];
  const step = flow.steps[stepIndex];
  const stepCount = flow.steps.length;
  const moving = !settled && !reducedMotion;

  // The visitor asked for less motion while it played: stop.
  useEffect(() => {
    if (reducedMotion) {
      setPlaying(false);
    }
  }, [reducedMotion]);

  useEffect(() => {
    if (!playing) {
      return;
    }
    const travel = settled || reducedMotion ? 0 : stepTravelMs(flowIndex, stepIndex);
    const timer = setTimeout(() => {
      setStepIndex((stepIndex + 1) % stepCount);
      setSettled(false);
    }, travel + STEP_DWELL_MS);
    return () => clearTimeout(timer);
  }, [playing, settled, reducedMotion, flowIndex, stepIndex, stepCount]);

  const selectFlow = (index: number) => {
    setFlowIndex(index);
    setStepIndex(0);
    setSettled(!playing);
  };

  const showStep = (index: number) => {
    setPlaying(false);
    setSettled(true);
    setStepIndex((index + stepCount) % stepCount);
  };

  const togglePlaying = () => {
    // Play after a step shown by hand runs that step from its start; after a
    // pause, the mark goes on from where it was held.
    setSettled(false);
    setPlaying(!playing);
  };

  const kinds = [...new Set(step.moves.map((move) => move.kind))];

  return (
    <>
      <section className="flows" aria-labelledby="wn-flows-heading">
        <h2 id="wn-flows-heading">Flows</h2>
        <div className="flow-picker" role="group" aria-label="Flow">
          {FLOWS.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={index === flowIndex}
              onClick={() => selectFlow(index)}
            >
              {candidate.name}
            </button>
          ))}
        </div>
        <p className="flow-summary">
          <Prose text={flow.summary} />
        </p>
        <div className="flow-controls" role="group" aria-label="Animation">
          <button type="button" onClick={togglePlaying}>
            {playing ? (
              <Pause size={14} aria-hidden="true" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={() => showStep(stepIndex - 1)}>
            <ChevronLeft size={14} aria-hidden="true" />
            Back
          </button>
          <button type="button" onClick={() => showStep(stepIndex + 1)}>
            Next
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
        {/* Announced only for a step the visitor asked for: while it plays,
            a screen reader would be interrupted every few seconds. */}
        <p className="flow-caption" aria-live={playing ? "off" : "polite"}>
          <span className="count">
            Step {stepIndex + 1} of {stepCount}
          </span>
          {kinds.map((kind) => (
            <span key={kind} className="flow-kind">
              <KindKey kind={kind} />
            </span>
          ))}
          <span>
            <Prose text={step.title} />
          </span>
        </p>
      </section>

      {/* The diagram scrolls sideways on narrow screens; Safari does not
          focus scroll containers on its own, so the wrapper takes focus
          to let keyboard users scroll it with the arrow keys. */}
      <div className="diagram-wrap" role="region" tabIndex={0} aria-label="webnode flow diagram">
        <FlowDiagram moves={PLACED_FLOWS[flowIndex][stepIndex]} moving={moving} playing={playing} />
      </div>

      {/* role="list" is explicit because Safari drops list semantics
          from lists styled with list-style:none (Tailwind preflight). */}
      <ul className="legend" role="list">
        {MESSAGE_KINDS.map((kind) => (
          <li className="legend-item" key={kind}>
            <KindKey kind={kind} />
          </li>
        ))}
        <li className="legend-item">
          <span className="swatch solid" aria-hidden="true" /> part of webnode
        </li>
        <li className="legend-item">
          <span className="swatch dash" aria-hidden="true" /> the network
        </li>
        <li className="legend-item">
          <span className="tagdot" aria-hidden="true">
            #
          </span>{" "}
          see note
        </li>
      </ul>

      <section className="steps" aria-labelledby="wn-steps-heading">
        <h3 id="wn-steps-heading">Steps: {flow.name}</h3>
        <ol role="list">
          {flow.steps.map((item, index) => (
            <li key={item.title} aria-current={index === stepIndex ? "step" : undefined}>
              <span className="n">{String(index + 1).padStart(2, "0")}</span>
              <span>
                <b>
                  <Prose text={item.title} />
                </b>{" "}
                <span className="d">
                  <Prose text={item.detail} />
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
