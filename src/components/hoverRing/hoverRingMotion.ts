/**
 * The hover ring: a thin line that grows along a control's edge from the point where the
 * pointer came in, and shrinks back toward the point where it left. HoverRing renders it;
 * this module holds its geometry and drives its animation, writing the ring's shape and
 * dash straight to the DOM so a hover never renders React.
 */

/** The ring's stroke, in screen pixels. */
export const HOVER_RING_WIDTH = 1;

/** Per 60 Hz frame, the share of the remaining distance the ring covers. */
const GROW_RATE = 0.25;
const SHRINK_RATE = 0.15;
const MOVE_RATE = 0.1;

/** A ring's box: its stroke's centre line, with that line's corner radius. */
export interface RingBox {
  width: number;
  height: number;
  radius: number;
}

/** Where a ray from the box's centre toward (x, y) leaves the box. */
export function edgePoint(width: number, height: number, x: number, y: number) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const dx = x - halfWidth;
  const dy = y - halfHeight;
  if (dx === 0 && dy === 0) return { x: halfWidth, y: 0 };
  if (dx === 0) return { x: halfWidth, y: halfHeight + halfHeight * Math.sign(dy) };
  const slope = Math.abs(dy / dx);
  return slope > halfHeight / halfWidth
    ? {
        x: halfWidth + (halfHeight / slope) * Math.sign(dx),
        y: halfHeight + halfHeight * Math.sign(dy),
      }
    : {
        x: halfWidth + halfWidth * Math.sign(dx),
        y: halfHeight + halfWidth * slope * Math.sign(dy),
      };
}

/**
 * How far round the box's rounded outline the point nearest (x, y) lies, as a percentage of
 * the outline. It counts as an SVG rect's outline does (its pathLength): clockwise from the
 * end of the top-left corner's curve.
 */
export function perimeterPercent({ width, height, radius }: RingBox, x: number, y: number) {
  if (!(width > 0 && height > 0)) return 0;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const top = width - 2 * r;
  const side = height - 2 * r;
  const corner = (Math.PI * r) / 2;
  const total = 2 * top + 2 * side + 4 * corner;
  const p = edgePoint(width, height, x, y);

  // Along a corner's curve, from the angle where it starts (radians, clockwise from +x).
  const along = (cx: number, cy: number, start: number) => {
    let angle = Math.atan2(p.y - cy, p.x - cx);
    if (angle < start - Math.PI) angle += 2 * Math.PI;
    return Math.max(0, Math.min(corner, (angle - start) * r));
  };

  const right = p.x > width - r;
  const left = p.x < r;
  const upper = p.y < r;
  const lower = p.y > height - r;
  let distance: number;
  if (right && upper) distance = top + along(width - r, r, -Math.PI / 2);
  else if (right && lower) distance = top + corner + side + along(width - r, height - r, 0);
  else if (left && lower)
    distance = 2 * top + 2 * corner + side + along(r, height - r, Math.PI / 2);
  else if (left && upper) distance = 2 * top + 3 * corner + 2 * side + along(r, r, Math.PI);
  else {
    // A straight edge: whichever the point lies on.
    const toTop = p.y;
    const toBottom = height - p.y;
    const toLeft = p.x;
    const toRight = width - p.x;
    const nearest = Math.min(toTop, toBottom, toLeft, toRight);
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
    if (nearest === toTop) distance = clamp(p.x - r, top);
    else if (nearest === toRight) distance = top + corner + clamp(p.y - r, side);
    else if (nearest === toBottom) distance = top + 2 * corner + side + clamp(width - r - p.x, top);
    else distance = 2 * top + 3 * corner + side + clamp(height - r - p.y, side);
  }
  return ((distance / total) * 100) % 100;
}

/** The shorter way round the outline from one percentage to another, signed. */
export function shortestTurn(from: number, to: number) {
  return ((((to - from) % 100) + 150) % 100) - 50;
}

interface Spring {
  value: number;
  target: number;
}

/** Moves a spring toward its target for `frames` 60 Hz frames; false once it has arrived. */
export function approach(spring: Spring, rate: number, frames: number) {
  spring.value += (spring.target - spring.value) * (1 - Math.pow(1 - rate, frames));
  if (Math.abs(spring.target - spring.value) < 0.01) {
    spring.value = spring.target;
    return false;
  }
  return true;
}

/** The radius of the ring's centre line, concentric with the host's own (outer) corner. */
export function ringRadius(
  hostRadius: string,
  gap: number,
  width: number,
  height: number,
  stroke = HOVER_RING_WIDTH,
) {
  const value = Number.parseFloat(hostRadius) || 0;
  const px = hostRadius.trim().endsWith("%") ? (value / 100) * Math.min(width, height) : value;
  return Math.max(0, Math.min(px + gap - stroke / 2, width / 2, height / 2));
}

/** The ring's shape for a host, in the host's own (untransformed) pixels. */
export interface RingShape {
  /** Where the svg sits in the host's padding box, which places an absolute child. */
  left: number;
  top: number;
  /** The svg: the host's border box grown by the gap on every side. */
  outerWidth: number;
  outerHeight: number;
  /** The stroke, sized to draw HOVER_RING_WIDTH on screen under the host's scale. */
  stroke: number;
  /** The stroke's centre line, inset half a stroke in the svg. */
  ring: RingBox;
}

export interface HostMetrics {
  /** The border box. */
  width: number;
  height: number;
  borderLeft: number;
  borderTop: number;
  /** The computed border-top-left-radius. */
  radius: string;
  /** Screen pixels per host pixel (a transformed ancestor's scale). */
  scale: number;
}

/** How far to move each edge of the svg, in host pixels, to land it on whole screen pixels. */
export interface PixelNudge {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const NO_NUDGE: PixelNudge = { left: 0, top: 0, right: 0, bottom: 0 };

/** The nudge that puts a box's edges (in screen pixels) on the screen's device pixels. */
export function pixelNudge(
  box: { left: number; top: number; right: number; bottom: number },
  devicePixelRatio: number,
  scale: number,
): PixelNudge {
  const snap = (edge: number) =>
    (Math.round(edge * devicePixelRatio) / devicePixelRatio - edge) / scale;
  return {
    left: snap(box.left),
    top: snap(box.top),
    right: snap(box.right),
    bottom: snap(box.bottom),
  };
}

export function ringShape(host: HostMetrics, gap: number, nudge = NO_NUDGE): RingShape {
  // A whole-pixel stroke on screen: a scaled-down host (the landing page's demo) widens it.
  const scale = host.scale > 0 && Number.isFinite(host.scale) ? host.scale : 1;
  const stroke = HOVER_RING_WIDTH / Math.min(4, Math.max(0.25, scale));
  const outerWidth = host.width + 2 * gap + nudge.right - nudge.left;
  const outerHeight = host.height + 2 * gap + nudge.bottom - nudge.top;
  const width = Math.max(0, outerWidth - stroke);
  const height = Math.max(0, outerHeight - stroke);
  return {
    // The gap counts from the border edge, outside any border.
    left: 0 - gap - host.borderLeft + nudge.left,
    top: 0 - gap - host.borderTop + nudge.top,
    outerWidth,
    outerHeight,
    stroke,
    ring: { width, height, radius: ringRadius(host.radius, gap, width, height, stroke) },
  };
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const px = (value: string) => Number.parseFloat(value) || 0;

// An untransformed box measures a hair off 1: its offsetWidth or computed width is rounded.
const roundNearOne = (scale: number) => (Math.abs(scale - 1) < 0.01 ? 1 : scale);

/**
 * Screen pixels per CSS pixel of a document, from the transformed frames it sits in (the
 * landing page scales its demo editor's iframe down): the document's own boxes don't show it.
 */
function frameScale(view: Window | null) {
  let scale = 1;
  try {
    for (; view?.frameElement; view = view.parent) {
      const frame = view.frameElement as HTMLElement;
      const width = frame.getBoundingClientRect().width;
      if (frame.offsetWidth > 0 && width > 0) scale *= width / frame.offsetWidth;
    }
  } catch {
    // A cross-origin parent: its transform is out of reach.
  }
  return roundNearOne(scale);
}

/** Where an element's box (screen pixels) fits inside another, give or take half a pixel. */
export function fitsWithin(
  box: { left: number; top: number; right: number; bottom: number },
  clip: { left: number; top: number; right: number; bottom: number },
) {
  return (
    box.left >= clip.left - 0.5 &&
    box.top >= clip.top - 0.5 &&
    box.right <= clip.right + 0.5 &&
    box.bottom <= clip.bottom + 0.5
  );
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far outside `host` its ring may reach, from the `reach` it asks for, without meeting
 * the ring of a neighbouring control: two controls set closer than their rings reach (a
 * toolbar's icons a couple of pixels apart) split the space between them, leaving
 * `separation` between the lines, so one ring fading out as the next draws never runs into
 * it. Each neighbour gives its box and the reach its own ring asks for, in the same pixels;
 * a box that overlaps the host's (a badge on its button) is no neighbour.
 */
export function neighbourReach(
  reach: number,
  host: Box,
  neighbours: { box: Box; reach: number }[],
  separation: number,
) {
  let room = reach;
  for (const { box, reach: theirs } of neighbours) {
    const dx = Math.max(box.left - host.right, host.left - box.right);
    const dy = Math.max(box.top - host.bottom, host.top - box.bottom);
    if (dx < 0 && dy < 0) continue;
    const distance = Math.max(dx, dy);
    if (distance >= reach + theirs + separation) continue;
    // The neighbour keeps to its half, as it works this out the same way.
    const their = Math.min(theirs, Math.max(0, (distance - separation) / 2));
    room = Math.min(room, distance - separation - their);
  }
  return Math.max(0, room);
}

/** Every attached ring's host, with the gap it asks for: one another's neighbours. */
const ringHosts = new Map<HTMLElement, number>();

/** The hosts round `host` that draw a ring, with how far (host pixels × scale) each reaches. */
function neighbourRings(host: HTMLElement, scale: number) {
  const neighbours: { box: Box; reach: number }[] = [];
  for (const [other, gap] of ringHosts) {
    if (other === host || other.ownerDocument !== host.ownerDocument) continue;
    const box = other.getBoundingClientRect();
    // Hidden, or under a modal (whose page is inert): not beside this control on screen.
    if (!(box.width > 0 && box.height > 0) || other.closest("[inert]")) continue;
    neighbours.push({ box, reach: gap * scale });
  }
  return neighbours;
}

/**
 * The area a ring outside the host can draw in: the padding boxes of the host and the
 * ancestors that clip what overflows them, intersected.
 */
const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);

function clipArea(host: HTMLElement) {
  const area = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  for (let element: HTMLElement | null = host; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (CLIPS.has(style.overflowX) || CLIPS.has(style.overflowY)) {
      const box = element.getBoundingClientRect();
      const left = box.left + element.clientLeft;
      const top = box.top + element.clientTop;
      area.left = Math.max(area.left, left);
      area.top = Math.max(area.top, top);
      area.right = Math.min(area.right, left + element.clientWidth);
      area.bottom = Math.min(area.bottom, top + element.clientHeight);
    }
    // Nothing above a fixed box clips it.
    if (style.position === "fixed") break;
  }
  return area;
}

function measureHost(host: HTMLElement, framed: number): HostMetrics {
  const style = getComputedStyle(host);
  const borderLeft = px(style.borderLeftWidth);
  const borderTop = px(style.borderTopWidth);
  // The used size, unrounded; offsetWidth (rounded) where there is none, as for an inline box.
  const box =
    style.boxSizing === "border-box"
      ? { x: 0, y: 0 }
      : {
          x:
            borderLeft +
            px(style.borderRightWidth) +
            px(style.paddingLeft) +
            px(style.paddingRight),
          y:
            borderTop +
            px(style.borderBottomWidth) +
            px(style.paddingTop) +
            px(style.paddingBottom),
        };
  const width = Number.parseFloat(style.width) + box.x || host.offsetWidth;
  const height = Number.parseFloat(style.height) + box.y || host.offsetHeight;
  const onScreen = host.getBoundingClientRect().width;
  const scale = (width > 0 && onScreen > 0 ? onScreen / width : 1) * framed;
  return {
    width,
    height,
    borderLeft,
    borderTop,
    radius: style.borderTopLeftRadius,
    scale: roundNearOne(scale),
  };
}

const isDisabled = (host: HTMLElement) => host.matches(':disabled, [aria-disabled="true"]');

/**
 * Animates the ring in `svg` (whose rect has pathLength 100) as the pointer enters and
 * leaves `host`. `gap` is how far outside the host's border edge the ring's outer edge
 * sits: less beside a neighbouring control's ring (see neighbourReach), and 0 where it
 * would be clipped. Returns the cleanup.
 */
export function attachHoverRing(host: HTMLElement, svg: SVGSVGElement, gap: number) {
  const rect = svg.querySelector("rect");
  if (!rect) return () => {};
  const size: Spring = { value: 0, target: 0 };
  const offset: Spring = { value: 0, target: 0 };
  let sizeRate = GROW_RATE;
  let frame = 0;
  let last: number | null = null;
  let shape: RingShape | null = null;
  // While the ring shows: its host can change size (Copy turning to Copied, or Follow to
  // Following, under the pointer), and a pointerleave can go missing (a keyed reorder moves
  // the hovered node).
  let resize: ResizeObserver | null = null;
  let watchingElsewhere = false;

  const place = (next: RingShape) => {
    shape = next;
    svg.style.left = `${shape.left}px`;
    svg.style.top = `${shape.top}px`;
    svg.style.width = `${shape.outerWidth}px`;
    svg.style.height = `${shape.outerHeight}px`;
    rect.setAttribute("x", `${shape.stroke / 2}`);
    rect.setAttribute("y", `${shape.stroke / 2}`);
    rect.setAttribute("width", `${shape.ring.width}`);
    rect.setAttribute("height", `${shape.ring.height}`);
    rect.setAttribute("rx", `${shape.ring.radius}`);
    rect.setAttribute("stroke-width", `${shape.stroke}`);
  };

  const reshape = () => {
    const framed = frameScale(host.ownerDocument.defaultView);
    const metrics = measureHost(host, framed);
    // In the document's pixels: a transformed ancestor scales the host's.
    const scale = metrics.scale / framed;
    const hostBox = host.getBoundingClientRect();
    // Outside the host, as far as its neighbours' rings leave room for (a screen pixel
    // between the lines); just inside its edge where an overflowing ancestor (or the host
    // itself) would clip the ring.
    let reach =
      gap > 0 ? neighbourReach(gap * scale, hostBox, neighbourRings(host, scale), 1 / framed) : 0;
    // On whole device pixels, which the svg's box is nudged onto below.
    if (framed === 1) {
      const dpr = window.devicePixelRatio || 1;
      reach = Math.floor(reach * dpr + 0.001) / dpr;
    }
    const outside = {
      left: hostBox.left - reach,
      top: hostBox.top - reach,
      right: hostBox.right + reach,
      bottom: hostBox.bottom + reach,
    };
    const ringGap = reach > 0 && fitsWithin(outside, clipArea(host)) ? reach / scale : 0;
    place(ringShape(metrics, ringGap));
    // A scaled frame's pixels don't line up with the screen's: no grid to snap to.
    if (framed !== 1) return;
    // The stroke is inset half its width in a box on whole screen pixels. A box on a fraction
    // of a pixel (a pill as wide as its text) would split the line across two pixels at half
    // strength, below the colour's contrast: move its edges onto the pixel grid.
    const nudge = pixelNudge(
      svg.getBoundingClientRect(),
      window.devicePixelRatio || 1,
      metrics.scale,
    );
    if (Object.values(nudge).some((edge) => Math.abs(edge) > 0.001)) {
      place(ringShape(metrics, ringGap, nudge));
    }
  };

  const render = () => {
    rect.style.strokeDasharray = `${size.value} ${100 - size.value}`;
    rect.style.strokeDashoffset = `${size.value / 2 - offset.value}`;
    // A round cap draws a zero-length dash as a dot; fade it in over the first few percent.
    rect.style.opacity = `${Math.min(size.value, 5) / 5}`;
  };

  const onElsewhere = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (event.target instanceof Node && host.contains(event.target)) return;
    aim(event, 0);
  };

  const watch = (on: boolean) => {
    if (on && !resize && typeof ResizeObserver === "function") {
      resize = new ResizeObserver(reshape);
      resize.observe(host);
    } else if (!on && resize) {
      resize.disconnect();
      resize = null;
    }
  };

  const watchElsewhere = (on: boolean) => {
    if (on === watchingElsewhere) return;
    watchingElsewhere = on;
    if (on) host.ownerDocument.addEventListener("pointerover", onElsewhere, true);
    else host.ownerDocument.removeEventListener("pointerover", onElsewhere, true);
  };

  const settle = () => {
    if (size.value === 0 && size.target === 0) watch(false);
  };

  const tick = (now: number) => {
    const frames = last === null ? 1 : Math.min((now - last) * 0.06, 4);
    last = now;
    const growing = approach(size, sizeRate, frames);
    const moving = approach(offset, MOVE_RATE, frames);
    render();
    if (growing || moving) {
      frame = requestAnimationFrame(tick);
    } else {
      frame = 0;
      last = null;
      settle();
    }
  };

  function aim(event: PointerEvent, target: number) {
    if (target > 0 || !shape) reshape();
    watch(true);
    watchElsewhere(target > 0);
    const { ring, outerWidth } = shape!;

    // The pointer is in screen pixels; map it onto the stroke's centre line there.
    const box = svg.getBoundingClientRect();
    const scale = outerWidth > 0 && box.width > 0 ? box.width / outerWidth : 1;
    const inset = ((outerWidth - ring.width) / 2) * scale;
    const at = perimeterPercent(
      { width: ring.width * scale, height: ring.height * scale, radius: ring.radius * scale },
      event.clientX - box.left - inset,
      event.clientY - box.top - inset,
    );
    // An empty or nearly whole ring starts from the pointer; one in motion turns toward it.
    if (size.value < 1 || size.value > 90) offset.value = offset.target = at;
    else offset.target = offset.value + shortestTurn(offset.value, at);
    sizeRate = target > size.value ? GROW_RATE : SHRINK_RATE;
    size.target = target;

    if (prefersReducedMotion()) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = null;
      size.value = size.target;
      offset.value = offset.target;
      render();
      settle();
    } else if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  }

  // A touch has no hover, and a disabled control does nothing on a click.
  const onEnter = (event: PointerEvent) => {
    if (event.pointerType === "touch" || isDisabled(host)) return;
    aim(event, 100);
  };
  // Any ring on screen came from a mouse or pen, which a touch elsewhere has not moved.
  const onLeave = (event: PointerEvent) => {
    if (event.pointerType === "touch" || (size.target === 0 && size.value === 0)) return;
    aim(event, 0);
  };

  host.addEventListener("pointerenter", onEnter);
  host.addEventListener("pointerleave", onLeave);
  ringHosts.set(host, gap);
  return () => {
    ringHosts.delete(host);
    host.removeEventListener("pointerenter", onEnter);
    host.removeEventListener("pointerleave", onLeave);
    cancelAnimationFrame(frame);
    watch(false);
    watchElsewhere(false);
    // Back to the stylesheet's empty ring, which a fresh attach (a new gap) starts from.
    rect.style.strokeDasharray = "";
    rect.style.strokeDashoffset = "";
    rect.style.opacity = "";
  };
}
