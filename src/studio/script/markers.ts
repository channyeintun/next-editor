/**
 * `[[mark:name]]` control-marker extraction (docs/agent-lesson-production.md
 * §5/§6). Markers are removed before TTS and captions but their positions are
 * retained in the token stream so the Director can resolve narration-relative
 * action anchors. Translators must preserve marker ids, so validation is
 * strict: every marker id may occur at most once across the whole script, and
 * every anchor must reference an existing marker.
 */

const MARKER_PATTERN = /\[\[mark:([A-Za-z0-9_-]+)\]\]/g;

export interface NarrationMarker {
  name: string;
  /** Index of the display token the marker precedes (tokens.length = end). */
  beforeTokenIndex: number;
}

export interface SceneNarration {
  sceneId: string;
  /** Display tokens (whitespace-split, punctuation attached, markers removed). */
  tokens: string[];
  /** Global index of this scene's first token. */
  firstTokenIndex: number;
  markers: NarrationMarker[];
}

export interface ExtractedNarration {
  /** All display tokens across scenes, in narration order. */
  tokens: string[];
  scenes: SceneNarration[];
  /** Marker name → marker (unique across the whole narration). */
  markers: Map<string, NarrationMarker>;
}

export class MarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkerError";
  }
}

function tokenizeSegment(segment: string): string[] {
  return segment.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Extract markers and display tokens from scene narrations. A marker binds to
 * the next display token after it (or the end of the narration).
 */
export function extractNarration(
  sceneInputs: readonly { sceneId: string; narration: string }[],
): ExtractedNarration {
  const tokens: string[] = [];
  const scenes: SceneNarration[] = [];
  const markers = new Map<string, NarrationMarker>();

  for (const { sceneId, narration } of sceneInputs) {
    const firstTokenIndex = tokens.length;
    const sceneMarkers: NarrationMarker[] = [];

    let lastIndex = 0;
    MARKER_PATTERN.lastIndex = 0;
    for (;;) {
      const match = MARKER_PATTERN.exec(narration);
      const segment = narration.slice(lastIndex, match ? match.index : undefined);
      tokens.push(...tokenizeSegment(segment));
      if (!match) {
        break;
      }

      const name = match[1];
      if (markers.has(name)) {
        throw new MarkerError(`Marker "${name}" occurs more than once`);
      }
      const marker: NarrationMarker = { name, beforeTokenIndex: tokens.length };
      markers.set(name, marker);
      sceneMarkers.push(marker);
      lastIndex = match.index + match[0].length;
    }

    // A malformed half-token like "[[mark:x" would silently narrate as text;
    // reject anything that still looks like a marker after extraction.
    const leftover = tokens.slice(firstTokenIndex).find((token) => token.includes("[[mark:"));
    if (leftover) {
      throw new MarkerError(`Scene "${sceneId}" contains a malformed marker near "${leftover}"`);
    }

    if (tokens.length === firstTokenIndex) {
      throw new MarkerError(`Scene "${sceneId}" has no narration text besides markers`);
    }

    scenes.push({
      sceneId,
      tokens: tokens.slice(firstTokenIndex),
      firstTokenIndex,
      markers: sceneMarkers,
    });
  }

  return { tokens, scenes, markers };
}

/** The display text (markers removed) — the caption source of truth. */
export function displayTextOf(extracted: ExtractedNarration): string {
  return extracted.tokens.join(" ");
}

export function requireMarker(extracted: ExtractedNarration, name: string): NarrationMarker {
  const marker = extracted.markers.get(name);
  if (!marker) {
    const known = Array.from(extracted.markers.keys()).join(", ") || "(none)";
    throw new MarkerError(`Unknown marker "${name}" — known markers: ${known}`);
  }
  return marker;
}
