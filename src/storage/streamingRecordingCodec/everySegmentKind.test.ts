import { describe, expect, it } from "vite-plus/test";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { createContentDelta } from "../../core/src/utils/contentDelta";
import { normalizeRecordingData } from "../../core/src/utils/editorState";
import { RECORDING_TRACK_NAMES } from "../../core/src/machine/recordingAssembly";
import type { PreviewDomPatchBatch } from "../../core/src/preview";
import type { WorkspaceRecordingSnapshot } from "../../types/workspace";
import { createStreamingRecordingReader, decodeRecordingStream, encodeRecordingToStream } from ".";
import type { DecodedRecording } from "./decode";
import {
  decodeRecords,
  findFooterStart,
  isKnownSegmentKind,
  isSegmentKind,
  parseHeader,
  readSegmentHeader,
  RETIRED_SEGMENT_KIND,
  SEGMENT_HEADER_SIZE,
  SEGMENT_KIND,
  type RecordingStreamMeta,
} from "./format";

// One recording that holds a record of every segment kind, written so that each of the
// codec's own transforms runs: workspace files deduped against the header snapshot (one
// unchanged, one spliced), a preview patch add rebuilt from an earlier template, and a
// frame's preview content deduped within its segment. If a kind's decode case went
// missing, that track would come back empty and the per-track comparison fails.
// A second keyframe starts a second cluster, so the later workspace splice and patch
// template are written into a later segment than the records they point back to: the
// readers keep that dedup state for the whole stream, not per segment.

const LONG_SOURCE = "export const greeting = 'hello';\n".repeat(20);
const PREVIEW_HTML = "<main>the same static preview page</main>".repeat(20);
const ASSET_DESCRIPTOR = {
  kind: "asset" as const,
  assetId: "sha256-logo",
  mimeType: "image/png",
  size: 4,
};
const ASSET_BYTES = new Uint8Array([137, 80, 78, 71]);

function workspace(source: string, activeFilePath = "src/main.ts"): WorkspaceRecordingSnapshot {
  return {
    project: {
      id: "project-every-kind",
      name: "Every kind",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: ["src", "assets"],
      files: {
        "index.html": {
          path: "index.html",
          name: "index.html",
          language: "html",
          content: "<script src='src/main.ts'></script>",
        },
        "src/main.ts": {
          path: "src/main.ts",
          name: "main.ts",
          language: "typescript",
          content: source,
        },
        "assets/logo.png": {
          path: "assets/logo.png",
          name: "logo.png",
          language: "binary",
          content: ASSET_DESCRIPTOR,
          encoding: "asset",
        },
      },
    },
    activeFilePath,
    collapsedFolders: [],
    sidebarScrollTop: 0,
  };
}

const SELECTION = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

const SECOND_CLUSTER_START = 250;

function keyframe(timestamp: number, scrollTop: number) {
  return {
    timestamp,
    isKeyframe: true,
    state: {
      content: LONG_SOURCE,
      position: { lineNumber: 1, column: 1 },
      selection: SELECTION,
      viewState: null,
      previewState: { isOpen: true, content: PREVIEW_HTML, scrollTop },
    },
  };
}

const FRAMES = [
  keyframe(0, 0),
  // The delta form repeats the whole preview state when its scroll moves, so this
  // frame's content is a repeat the writer replaces with a marker.
  {
    timestamp: 16,
    isKeyframe: false,
    previewState: { isOpen: true, content: PREVIEW_HTML, scrollTop: 40 },
  },
  keyframe(SECOND_CLUSTER_START, 40),
] as unknown as DeltaFrame[];

function patchBatch(time: number, idBase: number): PreviewDomPatchBatch {
  return {
    version: 2,
    time,
    source: "runtime-preview",
    documentId: "doc-1",
    route: "/",
    events: [
      {
        type: 3,
        timestamp: 1_700_000_000_000 + time,
        data: {
          source: 0,
          texts: [],
          attributes: [],
          removes: [],
          adds: [
            {
              parentId: 10,
              nextId: null,
              node: {
                type: 2,
                tagName: "li",
                attributes: { class: "row" },
                childNodes: [{ type: 3, textContent: "a remounted row", id: idBase + 1 }],
                id: idBase,
              },
            },
          ],
        },
      },
    ],
  };
}

function makeRecording(): DecodedRecording {
  const chatDelta = createContentDelta("", "Hello!");
  if (!chatDelta) throw new Error("Expected a chat content delta");
  return {
    version: 4,
    id: "recording-every-kind",
    name: "Every segment kind",
    createdAt: 1_700_000_000_000,
    duration: 2_000,
    keyframeInterval: 120,
    frames: FRAMES,
    slideEvents: [{ timestamp: 100, type: "slide_open", slideId: "slide-1", indexv: 0 }],
    previewEvents: [{ type: "preview_open", timestamp: 120, isOpen: true }],
    previewInitialDocuments: [
      {
        version: 2,
        time: 130,
        documentId: "doc-1",
        route: "/",
        events: [{ type: 2, timestamp: 1_700_000_000_130, data: { node: { type: 0, id: 1 } } }],
      },
    ],
    // The second batch, in the second cluster, is written as a template of the first.
    previewPatchBatches: [patchBatch(140, 100), patchBatch(260, 200)],
    workspaceEvents: [
      // Identical to the header snapshot: every text file is written as unchanged.
      { timestamp: 200, snapshot: workspace(LONG_SOURCE) },
      // One small edit to a long file, in the second cluster: written as a splice of the
      // previous event's content, which sits in the first cluster's segment.
      { timestamp: 300, snapshot: workspace(`${LONG_SOURCE}// done\n`, "index.html") },
    ],
    workspaceAssets: [{ descriptor: ASSET_DESCRIPTOR, bytes: ASSET_BYTES }],
    runtimeEvents: [
      { timestamp: 400, snapshot: { mode: "single-file", status: "idle", consoleLines: ["hi"] } },
    ],
    cursorEvents: [{ timestamp: 500, x: 10, y: 20, visible: true }],
    whiteboardEvents: [
      {
        timestamp: 600,
        upserts: [{ id: "el-1", version: 1, versionNonce: 1, isDeleted: false, type: "freedraw" }],
        isOpen: true,
      },
    ],
    chatEvents: [{ timestamp: 700, event: { k: "content", delta: chatDelta } }],
    // Every header field, so a field one side drops shows up here too.
    tracks: [
      { id: "editor", kind: "editor", durationMs: 2_000 },
      { id: "audio", kind: "audio", mimeType: "audio/ogg", source: "microphone" },
      { id: "camera", kind: "camera", mimeType: "video/webm", source: "camera" },
    ],
    clusters: [
      { index: 0, startTimeMs: 0, endTimeMs: SECOND_CLUSTER_START, containsKeyframe: true },
      {
        index: 1,
        startTimeMs: SECOND_CLUSTER_START,
        endTimeMs: 2_000,
        containsKeyframe: true,
      },
    ],
    audioSource: "microphone",
    audioStartOffsetMs: 12,
    audioFile: "recording-every-kind.ogg",
    audioUrl: "https://example.test/recording-every-kind.ogg",
    cameraSource: "camera",
    cameraStartOffsetMs: 34,
    cameraCuts: [{ start: 500, end: 900 }],
    cameraFile: "recording-every-kind.webm",
    cameraUrl: "https://example.test/recording-every-kind.webm",
    captions: [
      { id: "en", language: "en", label: "English", cues: [{ start: 0, end: 900, text: "Hi" }] },
    ],
    captionFiles: ["recording-every-kind.en.vtt"],
    chapters: [{ time: 0, title: "Start" }],
    slides: [{ id: "slide-1", content: "<h1>One</h1>", contentType: "html", order: 0 }],
    workspaceSnapshot: workspace(LONG_SOURCE),
    runtimeSnapshot: { mode: "single-file", status: "idle" },
  };
}

// Every header field, by whether the decoded recording carries it. Keyed by the header
// type, so a field added there has to be placed here before this file compiles.
const HEADER_FIELDS = {
  version: true,
  id: true,
  name: true,
  keyframeInterval: true,
  createdAt: true,
  duration: true,
  tracks: true,
  clusters: true,
  audioType: false,
  audioSource: true,
  audioStartOffsetMs: true,
  audioFile: true,
  audioUrl: true,
  cameraType: false,
  cameraSource: true,
  cameraStartOffsetMs: true,
  cameraCuts: true,
  cameraFile: true,
  cameraUrl: true,
  captions: true,
  captionFiles: true,
  chapters: true,
  slides: true,
  workspaceSnapshot: true,
  runtimeSnapshot: true,
} satisfies Record<keyof RecordingStreamMeta, boolean>;

const HEADER_FIELDS_ON_THE_RECORDING = (
  Object.keys(HEADER_FIELDS) as (keyof typeof HEADER_FIELDS)[]
).filter((field) => HEADER_FIELDS[field]) as Exclude<
  keyof RecordingStreamMeta,
  "audioType" | "cameraType"
>[];

/** The undecoded (marker-carrying) records of every segment, by kind, one array per segment. */
function rawSegmentsByKind(bytes: Uint8Array): Map<number, unknown[][]> {
  const { headerEnd } = parseHeader(bytes);
  const footerStart = findFooterStart(bytes, headerEnd);
  if (footerStart === null) throw new Error("Expected a finalized stream");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byKind = new Map<number, unknown[][]>();
  let offset = headerEnd;
  while (offset < footerStart) {
    const header = readSegmentHeader(view, offset);
    const payloadStart = offset + SEGMENT_HEADER_SIZE;
    const payload = bytes.subarray(payloadStart, payloadStart + header.byteLength);
    const records =
      header.kind === SEGMENT_KIND.workspaceAsset ? [payload] : decodeRecords<unknown>(payload);
    byKind.set(header.kind, [...(byKind.get(header.kind) ?? []), records]);
    offset = payloadStart + header.byteLength;
  }
  return byKind;
}

describe("a recording with every segment kind", () => {
  it("holds a record of every track, and writes a segment of every kind", async () => {
    const recording = makeRecording();
    for (const name of RECORDING_TRACK_NAMES) {
      // A track added without a record here would make the round trip below prove nothing.
      expect({ [name]: recording[name]?.length ?? 0 }).not.toEqual({ [name]: 0 });
    }

    const bytes = await encodeRecordingToStream(recording);
    const kinds = [...rawSegmentsByKind(bytes).keys()].sort((a, b) => a - b);
    expect(kinds).toEqual(Object.values(SEGMENT_KIND).sort((a, b) => a - b));
  });

  it("runs each of the codec's transforms on the way to disk", async () => {
    const raw = rawSegmentsByKind(await encodeRecordingToStream(makeRecording()));
    const text = (kind: number) => JSON.stringify(raw.get(kind));

    expect(text(SEGMENT_KIND.workspace)).toContain('"contentUnchanged":true');
    expect(text(SEGMENT_KIND.workspace)).toContain('"contentSplice"');
    expect(text(SEGMENT_KIND.previewPatch)).toContain('"dedupTemplate"');
    expect(text(SEGMENT_KIND.frames)).toContain('"contentDeduped":true');
  });

  it("writes the splice and the patch template in a later segment than their source", async () => {
    const raw = rawSegmentsByKind(await encodeRecordingToStream(makeRecording()));
    const segmentTexts = (kind: number) =>
      (raw.get(kind) ?? []).map((records) => JSON.stringify(records));

    const workspace = segmentTexts(SEGMENT_KIND.workspace);
    expect(workspace).toHaveLength(2);
    expect(workspace[0]).not.toContain('"contentSplice"');
    expect(workspace[1]).toContain('"contentSplice"');

    const patches = segmentTexts(SEGMENT_KIND.previewPatch);
    expect(patches).toHaveLength(2);
    expect(patches[0]).not.toContain('"dedupTemplate"');
    expect(patches[1]).toContain('"dedupTemplate"');
  });

  it("decodes every track, the assets and the header back to what was encoded", async () => {
    const recording = makeRecording();
    const expected = normalizeRecordingData(recording);
    const bytes = await encodeRecordingToStream(recording);
    const decoded = decodeRecordingStream(bytes);

    for (const name of RECORDING_TRACK_NAMES) {
      expect({ [name]: decoded[name] }).toEqual({ [name]: expected[name] });
    }
    expect(decoded.workspaceAssets).toEqual(recording.workspaceAssets);
    for (const field of HEADER_FIELDS_ON_THE_RECORDING) {
      expect({ [field]: recording[field] }).not.toEqual({ [field]: undefined });
      expect({ [field]: decoded[field] }).toEqual({ [field]: recording[field] });
    }
    // The media types stay in the header; the recording reads them from its track list.
    const { meta } = parseHeader(bytes);
    expect(meta.audioType).toBe("audio/ogg");
    expect(meta.cameraType).toBe("video/webm");
  });

  it("takes in exactly the table's kinds and the retired one, and steps over the rest", () => {
    const takenIn = Array.from({ length: 256 }, (_, kind) => kind).filter(isKnownSegmentKind);
    expect(takenIn).toEqual(
      [...Object.values(SEGMENT_KIND), RETIRED_SEGMENT_KIND].sort((a, b) => a - b),
    );
    expect(isSegmentKind(RETIRED_SEGMENT_KIND)).toBe(false);
  });

  it("decodes the same way when the bytes arrive in pieces", async () => {
    const bytes = await encodeRecordingToStream(makeRecording());
    const reader = createStreamingRecordingReader();
    for (let offset = 0; offset < bytes.length; offset += 97) {
      reader.push(bytes.subarray(offset, offset + 97));
    }

    expect(reader.isFinalized()).toBe(true);
    expect(reader.getRecording()).toEqual(decodeRecordingStream(bytes));
  });
});
