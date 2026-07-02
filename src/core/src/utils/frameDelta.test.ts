import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { EditorFrame } from "../types";
import type { Keyframe } from "./deltaTypes";
import { compressFrames, reconstructFrameAtIndex } from "./frameDelta";
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
