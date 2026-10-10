import type { StudioRuntimeMode } from "./plan";

/**
 * How a studio render is launched: the /studio route's `?runtime=` and
 * `?autostart=` contract, and how long the studio-render CLI waits for one
 * render. These change with the route or the CLI, not with the plan contract.
 */

export interface RuntimeModeParam {
  /** The requested mode, or null when no usable `runtime` value was supplied. */
  mode: StudioRuntimeMode | null;
  /** True when a non-empty `runtime` value was supplied that is neither allowed value. */
  invalid: boolean;
  /** The raw value, echoed back for error messages. */
  raw: string | null;
}

/**
 * Parse the `runtime` query parameter the /studio route and the studio-render
 * CLI both document as `fixture | live`. A missing (or empty) param yields
 * `mode: null` so the caller uses the plan's pinned default; an unrecognized
 * value is surfaced as `invalid` rather than silently coerced to the default —
 * otherwise a caller who explicitly asked for `fixture` could be forced onto a
 * plan whose default is `live`, contacting the real service (STUDIO-05).
 */
export function parseRuntimeModeParam(raw: string | null): RuntimeModeParam {
  if (raw === "live" || raw === "fixture") {
    return { mode: raw, invalid: false, raw };
  }
  return { mode: null, invalid: raw !== null && raw !== "", raw };
}

/**
 * Whether `/studio?autostart=1` may start a render without a click.
 *
 * A render replaces the tab's workspace and, in live mode, makes playground
 * calls that spend the viewer's run budget against third-party services, so a
 * crafted link must not be able to trigger one from a plain page load. Only an
 * automation-controlled browser (`navigator.webdriver`, which headless Chrome
 * under scripts/studio-render.ts reports) honours the flag; everyone else gets
 * the plan preselected and waits for the Start render click.
 */
export function shouldAutostartRender(raw: string | null, automated: boolean): boolean {
  return raw === "1" && automated;
}

/**
 * Fixed part of how long scripts/studio-render.ts waits for one render: a
 * first-ever render downloads the ~125MB pocket-tts bundle into the browser
 * cache before it synthesizes anything.
 */
const STUDIO_RENDER_WAIT_BASE_MS = 420_000;

/**
 * How long scripts/studio-render.ts waits for one render to finish, given the
 * lesson's estimated narration length. The performance plays the narration in
 * real time (one narration length), and synthesis, compilation, Opus encoding
 * and QA get a second; the doubling also absorbs a narrator slower than the
 * pre-synthesis wpm estimate. A fixed cap would make any long lesson — the
 * crash courses run 8–29 minutes — impossible to render from the CLI.
 */
export function studioRenderWaitMs(estimatedNarrationMs: number): number {
  return STUDIO_RENDER_WAIT_BASE_MS + 2 * Math.max(0, estimatedNarrationMs);
}

/** The speaking rate the render-wait budget assumes before any audio exists. */
const RENDER_WAIT_WORDS_PER_MINUTE = 140;

/**
 * A rough narration length for `studioRenderWaitMs`, from the script's word
 * count. It only sizes a timeout: it says nothing about real pacing, which
 * exists only once the narration is synthesized.
 */
export function estimateNarrationMsForRenderWait(wordCount: number): number {
  return (Math.max(0, wordCount) / RENDER_WAIT_WORDS_PER_MINUTE) * 60_000;
}
