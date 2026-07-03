import type { DeltaFrame } from "../../core/src/utils/deltaTypes";

// ============================================================================
// Frame previewState.content dedup (stream-only, per-segment representation)
//
// The frame delta format re-emits the WHOLE `previewState` object whenever any
// part of it changes — including its `content` string, the full static-preview
// HTML. Scrolling the preview mutates previewState at animation-frame rate, so
// a page with a large document re-embeds the same ~60KB content 60 times per
// second (a measured 30s lesson carried 337 identical copies: ~20MB raw,
// 3.8MB after deflate — each copy larger than deflate's 32KB window, so
// compression cannot collapse the repeats).
//
// On encode, a frame whose previewState.content is byte-identical to the last
// content written EARLIER IN THE SAME SEGMENT is stored with `content: ""` and
// a `contentDeduped: true` marker; on decode the marker is resolved by
// carrying the content forward (sharing the string reference, so rehydration
// is memory-cheap). Distinct from the DELTA-level `contentUnchanged` marker
// (deltaTypes.ts PreviewStateContentUnchanged): that one is part of the frame
// format itself, lives in memory, and is resolved by applyFrameDelta against
// the base-frame chain — this codec pass must never touch it, which falls out
// of the rules below: delta-marker previewStates carry no content string, so
// the stripper skips them, and only `contentDeduped` triggers the hydrator.
// This pass still pays off for keyframes and for recordings captured before
// the delta-level fix. Unlike the workspace/previewPatch dedups, the carry NEVER
// crosses a segment boundary: frame segments are keyframe-bounded and
// advertised as range-loadable, so every segment must stay self-contained —
// the first content-bearing frame of each segment always carries its full
// content. The marker exists ONLY inside the stream: in-memory `Recording`
// objects never carry it, and a decode(encode(x)) round-trip reproduces `x`
// exactly. Both strip and hydrate are pure per-segment calls (no writer/reader
// state), so encoders and decoders cannot fall out of lockstep.
//
// `previewState` lives at the frame top level on delta frames and under
// `state.previewState` on keyframes; both locations share one carry within a
// segment.
// ============================================================================

/** Stream-only shape: a `PreviewState` whose content was deduped away. */
interface DedupedPreviewState extends Record<string, unknown> {
  content?: unknown;
  contentDeduped?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walks a segment's frames mapping each previewState (top-level and keyframe
 * `state.previewState`) through `mapPreviewState` in frame order, copying only
 * what changes — untouched frames keep their original references (input is
 * live app state, never mutated).
 */
function mapFramePreviewStates(
  frames: ReadonlyArray<unknown>,
  mapPreviewState: (previewState: DedupedPreviewState) => DedupedPreviewState,
): unknown[] {
  return frames.map((frame) => {
    if (!isRecord(frame)) {
      return frame;
    }

    let next: Record<string, unknown> | null = null;

    if (isRecord(frame.previewState)) {
      const mapped = mapPreviewState(frame.previewState);
      if (mapped !== frame.previewState) {
        next = { ...frame, previewState: mapped };
      }
    }

    const state = frame.state;
    if (isRecord(state) && isRecord(state.previewState)) {
      const mapped = mapPreviewState(state.previewState);
      if (mapped !== state.previewState) {
        next = { ...(next ?? frame), state: { ...state, previewState: mapped } };
      }
    }

    return next ?? frame;
  });
}

/**
 * Strips repeated previewState contents within ONE frame segment. Pure per
 * call — invoke once per segment so the segment stays self-contained.
 */
export function stripFramePreviewContent(frames: ReadonlyArray<unknown>): unknown[] {
  let lastContent: string | null = null;

  return mapFramePreviewStates(frames, (previewState) => {
    const content = previewState.content;
    if (typeof content !== "string" || content === "") {
      return previewState;
    }
    if (content === lastContent) {
      return { ...previewState, content: "", contentDeduped: true };
    }
    lastContent = content;
    return previewState;
  });
}

/**
 * Resolves `contentDeduped` markers within ONE decoded frame segment by
 * carrying contents forward, restoring exactly what was stripped. Runs before
 * frame normalization so the marker never reaches in-memory recordings.
 */
export function hydrateFramePreviewContent(frames: DeltaFrame[]): DeltaFrame[] {
  let lastContent: string | null = null;

  return mapFramePreviewStates(frames, (previewState) => {
    if (previewState.contentDeduped) {
      const { contentDeduped: _contentDeduped, ...rest } = previewState;
      return { ...rest, content: lastContent ?? "" };
    }
    const content = previewState.content;
    if (typeof content === "string" && content !== "") {
      lastContent = content;
    }
    return previewState;
  }) as DeltaFrame[];
}
