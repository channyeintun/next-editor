# Keyframe & Delta Architecture (V2)

This document details the **Version 2 (V2)** architecture for the editor recording engine, which transitions from storing full snapshots to a highly efficient **Keyframe + Delta** format. This change reduces recording file sizes by 70-90% while maintaining millisecond-precise playback and instant seeking.

## Core Concepts

### 1. Frame vs. Snapshot

In V1, every recorded event was a "Snapshot" containing the full state of the editor. In V2, we use **Frames**:

- **Keyframe**: A complete snapshot of the editor state (Content, Selection, ViewState, etc.). These serve as restoration points.
- **Delta Frame**: A lightweight specific description of _what changed_ since the previous frame.

### 2. Keyframe Interval

To balance compression ratio with seeking performance, we use a fixed interval (default: **120 frames**).

- **Storage**: Most frames are small Deltas.
- **Seeking**: To jump to a specific time, the engine finds the nearest preceding Keyframe and re-applies the subsequent Deltas. This ensures seeking is instant even in long recordings.

---

## Data Structures

### Content Delta

Instead of storing the full text, we store an opaque diff-match-patch (Myers) delta that transforms the previous frame's content into this one. Unlike the former prefix/suffix ("affix") model, it stays compact across multiple, non-contiguous edits.

```typescript
interface ContentDelta {
  delta: Uint8Array; // opaque diff-match-patch delta (see Compression Algorithms)
}
```

### Frame Delta

A `FrameDelta` structure is optimized to only include fields that typically change.

```typescript
interface FrameDelta {
  timestamp: number;
  isKeyframe: false;

  // Differential updates
  contentDelta?: ContentDelta;
  positionDelta?: { lineDelta: number; columnDelta: number };
  selectionDelta?: { startLineDelta: number; startColumnDelta: number; ... };

  // Absolute updates (only included if changed)
  viewState?: ICodeEditorViewState;
  mouseCursor?: MouseCursorPosition;
  slideState?: SlidePreviewState;
}
```

### Delta Recording

The top-level storage format.

```typescript
interface DeltaRecording {
  version: 2;
  frames: (Keyframe | FrameDelta)[];
  keyframeInterval: 120;
  // ... metadata (audio, slides, duration)
}
```

---

## Compression Algorithms

### WebAssembly diff-match-patch

To compute `ContentDelta` compactly:

1.  **Rust core**: `diffDelta(a, b)` / `applyDelta(a, delta)` are a diff-match-patch (Myers middle-snake) implementation in Rust (`no_std`), compiled to a tiny **zero-import** WebAssembly module (`src/core/dmp/`, ~6.7 KB). `createContentDelta` / `applyContentDelta` in `frameDelta.ts` round-trip the delta through it (loaded via the host wrapper in `src/storage/dmpCodec/`).
2.  **Why Myers, not affix**: the earlier prefix/suffix model bloated to near-keyframe size whenever an edit touched both ends of the document; the Myers diff stays small across scattered, non-contiguous edits.
3.  **Performance & UTF-8 safety**: Wasm diffs the raw UTF-8 bytes directly (predictable, fast). `applyDelta` reconstructs the target bytes exactly, so the round-trip is byte-exact and can never split a multi-byte character.

> **Note:** the prefix/suffix helpers `findCommonPrefixLength` / `findCommonSuffixLength` (in `frameDelta.ts`, backed by the pure-JS `stringAffix.ts`) are **not** WebAssembly and are **no longer used for `ContentDelta`**. The original AssemblyScript affix module was removed when the codec moved to diff-match-patch. These JS helpers remain only to compute a minimal edit range when applying content to the live Monaco editor (`editorDiff.ts`).

> The codec's implementation language has changed four times (AssemblyScript affix → Go/TinyGo zstd+go-diff → AssemblyScript diff-match-patch → Rust diff-match-patch). See [`codec-history.md`](./codec-history.md) for the rationale behind each move.

### Position/Selection compression

Since cursors mostly move short distances:

- We store relative offsets (`lineDelta`, `columnDelta`) instead of absolute coordinates.
- If a value is `0` (no movement), it is omitted entirely.

---

## Reconstruction Logic

To render a specific frame at `index`:

1.  **Find Base**: Locate the nearest Keyframe at `floor(index / interval) * interval`.
2.  **Hydrate**: Start with the Keyframe's full state.
3.  **Roll Forward**: Iterate from `keyframeIndex + 1` to `index`.
    - Apply `applyFrameDelta(currentState, deltaFrame)` for each step.
    - Since `interval` is small (120), this loop is negligible (~2ms).

## Migration & Logic Updates

- **File Renaming**: `EditorSnapshot` → `EditorFrame`.
- **Utilities**: `snapshotDelta.ts` → `frameDelta.ts`.
- **UI**: Components now reference `RecordingEditor` instead of `SnapshotEditor`.
