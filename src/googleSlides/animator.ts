// Replays the build-step animations of an imported Google Slides slide against
// its inline SVG. Ported from the reference implementation (see
// google-slide-research.md §1.5). The timeline math is pure and testable; the
// class wraps DOM application and a single requestAnimationFrame tween used for
// the one-step-forward case.

import type { DeckStep, DeckStepEntry } from "./types";

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface TimedEntry {
  entry: DeckStepEntry;
  /** Absolute start time on the deck timeline (ms). */
  start: number;
  /** Absolute end time (start + duration). */
  end: number;
}

export interface DeckTimeline {
  entries: TimedEntry[];
  /** End time of each step; stepEndTimes[i] is the time at which step i is fully shown. */
  stepEndTimes: number[];
  /** Total timeline length (ms) = time at which every step is revealed. */
  total: number;
}

/**
 * Lays steps end-to-end on a single timeline. Each step starts where the
 * previous ended; within a step, an entry starts at its delay and lasts its
 * duration, so the step's length is the max of (delay + duration) over its
 * entries.
 */
export function buildTimeline(steps: DeckStep[]): DeckTimeline {
  const entries: TimedEntry[] = [];
  const stepEndTimes: number[] = [];
  let cursor = 0;
  for (const step of steps) {
    let stepLength = 0;
    for (const entry of step) {
      const start = cursor + entry.delayMs;
      const end = start + entry.durationMs;
      entries.push({ entry, start, end });
      stepLength = Math.max(stepLength, entry.delayMs + entry.durationMs);
    }
    cursor += stepLength;
    stepEndTimes.push(cursor);
  }
  return { entries, stepEndTimes, total: cursor };
}

export interface ElementStyle {
  opacity?: number;
  transform?: string;
}

/**
 * Computes the inline styles (opacity, transform) for every animated element at
 * time `t` on the timeline. Opacity interpolates linearly; scale/translate use
 * easeInOutCubic (matching the reference). When an element has both scale and
 * translate tracks the transforms are combined into one string.
 */
export function sampleStyles(timeline: DeckTimeline, t: number): Map<string, ElementStyle> {
  const styles = new Map<string, ElementStyle>();
  for (const { entry, start, end } of timeline.entries) {
    const duration = end - start;
    const linear =
      duration <= 0 ? (t >= end ? 1 : 0) : Math.min(Math.max((t - start) / duration, 0), 1);
    const eased = easeInOutCubic(linear);

    const style: ElementStyle = styles.get(entry.elementId) ?? {};
    let scale: number | undefined;
    const translate: { x: number; y: number } = { x: 0, y: 0 };
    let hasTranslate = false;

    // Seed from any transform already accumulated for this element is avoided;
    // each entry re-derives its own transform. Elements typically appear in a
    // single step, so this stays simple.
    for (const track of entry.tracks) {
      if (track.kind === "opacity") {
        style.opacity = track.from + (track.to - track.from) * linear;
      } else if (track.kind === "scale") {
        scale = track.from + (track.to - track.from) * eased;
      } else if (track.kind === "translate") {
        hasTranslate = true;
        translate.x = track.fromX + (track.toX - track.fromX) * eased;
        translate.y = track.fromY + (track.toY - track.fromY) * eased;
      }
    }

    const parts: string[] = [];
    if (hasTranslate) parts.push(`translate(${translate.x * 100}%, ${translate.y * 100}%)`);
    if (scale !== undefined) parts.push(`scale(${scale})`);
    if (parts.length > 0) style.transform = parts.join(" ");

    styles.set(entry.elementId, style);
  }
  return styles;
}

/**
 * Maps a "steps revealed" count (0..steps.length) to a time on the timeline:
 * 0 → nothing revealed (t=0), k → end of step k-1, length → fully revealed.
 */
export function timeForRevealed(timeline: DeckTimeline, stepsRevealed: number): number {
  if (stepsRevealed <= 0) return 0;
  if (stepsRevealed >= timeline.stepEndTimes.length) return timeline.total;
  return timeline.stepEndTimes[stepsRevealed - 1];
}

export class DeckStepAnimator {
  private readonly svg: SVGSVGElement;
  private readonly timeline: DeckTimeline;
  private readonly elementCache = new Map<string, Element | null>();
  private revealed = 0;
  private rafId: number | null = null;
  // The first setRevealed after construction is a fresh mount / seek and always
  // snaps: landing at step 1 must not be mistaken for a user-driven forward step.
  private hasRevealed = false;

  constructor(svg: SVGSVGElement, steps: DeckStep[]) {
    this.svg = svg;
    this.timeline = buildTimeline(steps);
    // Start fully hidden so fade-in targets are not flashed before their step.
    this.apply(0);
  }

  private resolve(id: string): Element | null {
    if (!this.elementCache.has(id)) {
      this.elementCache.set(id, this.svg.querySelector(`#${CSS.escape(id)}`));
    }
    return this.elementCache.get(id) ?? null;
  }

  private apply(t: number): void {
    const styles = sampleStyles(this.timeline, t);
    for (const [id, style] of styles) {
      const el = this.resolve(id);
      if (!el || !(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      if (style.opacity !== undefined) el.style.opacity = String(style.opacity);
      el.style.transform = style.transform ?? "";
    }
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Reveals `stepsRevealed` steps (0..steps.length). A single forward increment
   * animates in real time; any other change (backward, multi-step jump, replay
   * seek) snaps instantly.
   */
  setRevealed(stepsRevealed: number, opts?: { playbackRate?: number }): void {
    this.cancelRaf();
    const target = timeForRevealed(this.timeline, stepsRevealed);
    // A fresh mount / seek (the first call) always snaps; only subsequent calls
    // can animate a single forward increment.
    const isSingleForward = this.hasRevealed && stepsRevealed === this.revealed + 1;
    const from = timeForRevealed(this.timeline, this.revealed);
    this.revealed = stepsRevealed;
    this.hasRevealed = true;

    if (!isSingleForward || target <= from || typeof requestAnimationFrame !== "function") {
      this.apply(target);
      return;
    }

    const rate = opts?.playbackRate && opts.playbackRate > 0 ? opts.playbackRate : 1;
    const wallDuration = (target - from) / rate;
    const startWall = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startWall;
      const p = wallDuration <= 0 ? 1 : Math.min(elapsed / wallDuration, 1);
      this.apply(from + (target - from) * p);
      if (p < 1) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  dispose(): void {
    this.cancelRaf();
  }
}
