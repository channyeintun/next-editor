import { useEffect, useRef } from "react";
import { attachHoverRing } from "./hoverRingMotion";

/**
 * A thin ring that traces its parent control's edge on hover: it grows both ways from
 * where the pointer came in and shrinks back toward where it left, while the control
 * brightens (see hoverRing.css). Render it inside the button itself (not a wrapper that
 * also holds the control's menu), normally as its last child; before any absolutely
 * placed badge that should paint over it. The control is
 * positioned for it unless it sets its own position, and must not be display: inline or
 * contents. The ring follows the control's top-left corner radius and is hidden while the
 * control is disabled.
 *
 * `gap` sets how far outside the control's border edge the ring's outer edge sits, in
 * pixels: by default a 1px line with a 1px dark strip between it and the control. Where an
 * overflowing parent (or the control itself) would clip that, the ring draws just inside
 * the edge instead, as `gap={0}` always does (for options that touch, in a segmented track).
 *
 * Its stylesheet, hoverRing.css, is imported by src/index.css rather than here: the landing
 * page's build-time prerender renders this component and cannot load a stylesheet import.
 */
export default function HoverRing({ gap = 2 }: { gap?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const host = svg?.parentElement;
    if (!svg || !(host instanceof HTMLElement)) return;
    return attachHoverRing(host, svg, gap);
  }, [gap]);

  // Sized and shaped on the first hover (see attachHoverRing); empty until then, even
  // before the stylesheet has loaded.
  return (
    <svg ref={svgRef} className="hover-ring" width="0" height="0" aria-hidden="true">
      <rect pathLength={100} fill="none" />
    </svg>
  );
}
