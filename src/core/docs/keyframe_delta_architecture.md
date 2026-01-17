# Keyframe & Delta Architecture (V2)

This document details the **Version 2 (V2)** architecture for the editor recording engine, which transitions from storing full snapshots to a highly efficient **Keyframe + Delta** format. This change reduces recording file sizes by 70-90% while maintaining millisecond-precise playback and instant seeking.

## Core Concepts

### 1. Frame vs. Snapshot
In V1, every recorded event was a "Snapshot" containing the full state of the editor. In V2, we use **Frames**:
- **Keyframe**: A complete snapshot of the editor state (Content, Selection, ViewState, etc.). These serve as restoration points.
- **Delta Frame**: A lightweight specific description of *what changed* since the previous frame.

### 2. Keyframe Interval
To balance compression ratio with seeking performance, we use a fixed interval (default: **120 frames**).
- **Storage**: Most frames are small Deltas.
- **Seeking**: To jump to a specific time, the engine finds the nearest preceding Keyframe and re-applies the subsequent Deltas. This ensures seeking is instant even in long recordings.

---

## Data Structures

### Content Delta
Instead of storing the full text, we calculate the common prefix and suffix between two states and store only the change.

```typescript
interface ContentDelta {
  prefixLen: number;  // Length of unchanged start
  suffixLen: number;  // Length of unchanged end
  insert: string;     // The new text inserted in the middle
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

### WebAssembly-Accelerated Diffing
To compute `ContentDelta` efficiently at 60fps:
1.  **AssemblyScript Core**: `findCommonPrefixLength` and `findCommonSuffixLength` are implemented in AssemblyScript and compiled to WebAssembly.
2.  **Performance**: Wasm operates directly on raw memory bytes, offering predictable high performance compared to JS string manipulation.
3.  **UTF-8 Safety Guard**: The implementation deliberately checks for multi-byte character boundaries (e.g., emojis). If a calculated split point lands in the middle of a UTF-8 sequence, the guard backtracks to the character start to ensure valid string operations.

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
