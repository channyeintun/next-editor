import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { EditorFrame } from "../types";
import type { PreviewState } from "../slides";
import type { Keyframe } from "./deltaTypes";
import {
  applyFrameDelta,
  compressFrames,
  createFrameDelta,
  reconstructFrameAtIndex,
} from "./frameDelta";
import {
  DmpBaseMismatchError,
  installDmpCodec,
  instantiateDmpCodec,
  isDmpCodecLoaded,
} from "../../../storage/dmpCodec/dmpCodec";

// Same artifact-gating as dmpCodec.test.ts: instantiate the wasm from bytes and
// skip when it hasn't been built (`bun run build:wasm`).
const wasmPath = resolve(process.cwd(), "src/core/dmp/build/next-editor-dmp.wasm");
const hasArtifact = existsSync(wasmPath);

const frameAt = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: {
    content,
    selection: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    },
    position: { lineNumber: 1, column: 1 },
    viewState: null,
    mouseCursor: { x: 0, y: 0, visible: false },
  },
});

describe.skipIf(!hasArtifact)("frameDelta reconstruction errors", () => {
  it("attributes a base-mismatch failure to the failing frame index", async () => {
    if (!isDmpCodecLoaded()) {
      installDmpCodec(await instantiateDmpCodec(readFileSync(wasmPath)));
    }

    const base = "const value = 1;\nconst other = 2;\n";
    const edited = base.replace("= 1", "= 9");
    const frames = compressFrames([frameAt(0, base), frameAt(100, edited)]);

    // Tamper the keyframe with same-length different content so the delta's
    // base-integrity check op fails only at apply time.
    (frames[0] as Keyframe).state.content = base.replace("value", "vAlue");

    let caught: unknown;
    try {
      reconstructFrameAtIndex(frames, 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DmpBaseMismatchError);
    expect((caught as Error).message).toMatch(/at frame 1/);
  });
});

// The delta format must stay incremental for previewState too: its `content`
// is the full static-preview HTML (tens of KB) and scroll ticks change
// previewState at animation-frame rate, so copying the object whole would
// re-embed the unchanged content per tick (a measured 30s lesson carried 337
// identical ~60KB copies).
describe("previewState delta stays incremental", () => {
  const PREVIEW_HTML = "<article>static preview document</article>".repeat(50);

  const withPreview = (timestamp: number, previewState: PreviewState | undefined): EditorFrame => {
    const frame = frameAt(timestamp, "editor content");
    return { ...frame, state: { ...frame.state, previewState } };
  };

  const preview = (content: string | undefined, scrollTop: number): PreviewState => ({
    size: { width: 400, height: 300 },
    isOpen: true,
    content,
    scrollTop,
  });

  it("omits unchanged content from a scroll-only previewState delta", () => {
    const prev = withPreview(0, preview(PREVIEW_HTML, 0));
    const next = withPreview(16, preview(PREVIEW_HTML, 120));

    const delta = createFrameDelta(prev, next);

    expect(delta.previewState).toEqual({
      size: { width: 400, height: 300 },
      isOpen: true,
      scrollTop: 120,
      contentUnchanged: true,
    });
    expect(JSON.stringify(delta)).not.toContain(PREVIEW_HTML.slice(0, 40));

    const applied = applyFrameDelta(prev, delta);
    expect(applied.state.previewState).toEqual(preview(PREVIEW_HTML, 120));
  });

  it("carries content through a chain of content-unchanged deltas", () => {
    const frames = [
      withPreview(0, preview(PREVIEW_HTML, 0)),
      withPreview(16, preview(PREVIEW_HTML, 40)),
      withPreview(32, preview(PREVIEW_HTML, 80)),
    ];

    let reconstructed = frames[0];
    for (let index = 1; index < frames.length; index += 1) {
      reconstructed = applyFrameDelta(
        reconstructed,
        createFrameDelta(frames[index - 1], frames[index]),
      );
    }

    expect(reconstructed.state.previewState).toEqual(preview(PREVIEW_HTML, 80));
  });

  it("reconstructs a content change exactly (patched or full form)", () => {
    const prev = withPreview(0, preview(PREVIEW_HTML, 0));
    const next = withPreview(16, preview("<p>new</p>", 0));

    // Depending on whether the dmp codec is installed this delta is a patch or
    // a full-copy fallback; the applied result must be identical either way.
    const delta = createFrameDelta(prev, next);

    expect(delta.previewState).toBeDefined();
    const applied = applyFrameDelta(prev, delta);
    expect(applied.state.previewState).toEqual(preview("<p>new</p>", 0));
  });

  it("emits full previewState when the preview appears for the first time", () => {
    const prev = withPreview(0, undefined);
    const next = withPreview(16, preview(PREVIEW_HTML, 0));

    const delta = createFrameDelta(prev, next);

    expect(delta.previewState).toEqual(preview(PREVIEW_HTML, 0));
    expect(applyFrameDelta(prev, delta).state.previewState).toEqual(preview(PREVIEW_HTML, 0));
  });

  // With the dmp codec installed, preview-content EDITS are stored as patches
  // against the base chain — like editor content — so live typing (and
  // undo/redo walking back through earlier versions) never re-embeds the full
  // preview HTML per change. A measured 40s editing session stored 60 full
  // ~58KB copies (27 distinct versions) before this.
  describe.skipIf(!hasArtifact)("content edits become dmp patches", () => {
    const versions = [
      PREVIEW_HTML,
      PREVIEW_HTML.replace("static preview", "static preview edited"),
      PREVIEW_HTML.replace("static preview", "static preview edited twice"),
    ];

    it("stores a typing + undo chain without re-embedding full contents", async () => {
      if (!isDmpCodecLoaded()) {
        installDmpCodec(await instantiateDmpCodec(readFileSync(wasmPath)));
      }

      // Type forward through the versions, then undo back down.
      const contents = [...versions, versions[1], versions[0]];
      const frames = contents.map((content, index) =>
        withPreview(index * 16, preview(content, index)),
      );

      let reconstructed = frames[0];
      for (let index = 1; index < frames.length; index += 1) {
        const delta = createFrameDelta(frames[index - 1], frames[index]);

        // The delta must carry a patch, never the full HTML.
        const encoded = JSON.stringify(delta.previewState);
        expect(encoded).toContain("contentDelta");
        expect(encoded.length).toBeLessThan(versions[0].length / 2);

        reconstructed = applyFrameDelta(reconstructed, delta, index);
        expect(reconstructed.state.previewState).toEqual(preview(contents[index], index));
      }
    });
  });
});
