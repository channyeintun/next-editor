import { describe, expect, it } from "vite-plus/test";
import { unzlibSync } from "fflate";
import { applyRecordingEdit } from "../core/src/recordingEdit";
import { diffRuntimeSnapshot } from "../core/src/runtimeTrack";
import type { EditorFrame, Recording } from "../core/src/types";
import type { RuntimeRecordingSnapshot } from "../core/src/runtime";
import { createContentDelta } from "../core/src/utils/contentDelta";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import type { WorkspaceRecordingSnapshot } from "../core/src/workspace";
import {
  decodeRecordingStream,
  encodeRecordingToStream,
  SEGMENT_KIND,
} from "./streamingRecordingCodec";
import {
  findFooterStart,
  HEADER_PREFIX_SIZE,
  parseHeader,
  readSegmentHeader,
  SEGMENT_HEADER_SIZE,
} from "./streamingRecordingCodec/format";

// Every track is given this text inside the cut and loses it again before the cut
// ends: a key pasted into a file and deleted, printed and scrolled away, typed into
// the agent prompt and cleared, written on the whiteboard and erased.
const SECRET = "sk-live-SECRET";
const cut = { start: 2_000, end: 5_000 };

const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

const frame = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: { content, selection, position: { lineNumber: 1, column: 1 }, viewState: null },
});

const workspace = (
  content: string,
  extra: Partial<WorkspaceRecordingSnapshot> = {},
): WorkspaceRecordingSnapshot => ({
  project: {
    id: "p",
    name: "P",
    lessonType: "html-css",
    entryFilePath: "a.txt",
    folders: [],
    files: { "a.txt": { path: "a.txt", name: "a.txt", language: "plaintext", content } },
  },
  activeFilePath: "a.txt",
  ...extra,
});

const runtime = (output: string): RuntimeRecordingSnapshot => ({
  mode: "webcontainer",
  status: "ready",
  terminalSessions: [{ id: "t", title: "Terminal", output }],
});

const text = (previous: string, next: string) => {
  const delta = createContentDelta(previous, next);
  if (!delta) throw new Error("expected a content delta");
  return delta;
};

const element = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id,
  version,
  versionNonce: version,
  isDeleted: false,
  index: `a${id}`,
  ...extra,
});

function take(): Recording {
  const runtimeStates = [
    runtime(""),
    runtime(`${SECRET}\n`),
    runtime("ok\n"),
    runtime("ok\nnext\n"),
  ];
  return {
    version: 4,
    id: "take",
    name: "Take",
    createdAt: 1,
    duration: 10_000,
    keyframeInterval: 120,
    workspaceSnapshot: workspace("a"),
    frames: compressFrames([
      frame(0, "a"),
      frame(1_000, "ab"),
      frame(3_000, `ab ${SECRET}`),
      frame(4_000, "ab"),
      frame(6_000, "abc"),
    ]),
    workspaceEvents: [
      { timestamp: 0, snapshot: workspace("a") },
      { timestamp: 3_100, snapshot: workspace(`ab ${SECRET}`, { collapsedFolders: ["src"] }) },
      { timestamp: 3_200, snapshot: workspace(`ab ${SECRET}`, { sidebarScrollTop: 12 }) },
      { timestamp: 6_000, snapshot: workspace("abc") },
    ],
    runtimeEvents: [
      { timestamp: 0, snapshot: runtimeStates[0] },
      { timestamp: 2_500, delta: diffRuntimeSnapshot(runtimeStates[0], runtimeStates[1]) },
      { timestamp: 3_000, delta: diffRuntimeSnapshot(runtimeStates[1], runtimeStates[2]) },
      { timestamp: 6_000, delta: diffRuntimeSnapshot(runtimeStates[2], runtimeStates[3]) },
    ],
    chatEvents: [
      { timestamp: 1_000, event: { k: "message_start", id: "m1", role: "user" } },
      { timestamp: 1_100, event: { k: "content", delta: text("", "hello") } },
      { timestamp: 2_500, event: { k: "draft", text: SECRET } },
      { timestamp: 2_600, event: { k: "message_start", id: "m2", role: "user" } },
      { timestamp: 2_700, event: { k: "content", delta: text("", `use ${SECRET}`) } },
      { timestamp: 2_800, event: { k: "remove", fromId: "m2" } },
      { timestamp: 2_900, event: { k: "draft", text: "" } },
    ],
    whiteboardEvents: [
      { timestamp: 1_000, upserts: [element("1", 1)], isOpen: true },
      { timestamp: 2_500, upserts: [element("2", 1, { text: SECRET })] },
      { timestamp: 2_600, upserts: [element("2", 2, { text: SECRET, isDeleted: true })] },
    ],
    previewInitialDocuments: [
      { version: 2, time: 0, documentId: "d", events: [{ type: 2, data: {}, timestamp: 0 }] },
    ],
    previewPatchBatches: [
      {
        version: 2,
        time: 2_500,
        source: "runtime-preview",
        documentId: "d",
        events: [{ type: 3, data: { texts: [{ id: 5, value: SECRET }] }, timestamp: 2_500 }],
      },
      {
        version: 2,
        time: 3_000,
        source: "runtime-preview",
        documentId: "d",
        events: [{ type: 3, data: { texts: [{ id: 5, value: "" }] }, timestamp: 3_000 }],
      },
    ],
    previewEvents: [
      { type: "preview_route_change", timestamp: 2_500, route: `/?key=${SECRET}` },
      { type: "preview_route_change", timestamp: 3_000, route: "/" },
    ],
  };
}

/** The segment kinds of a `.ne` file whose inflated records hold `needle`, and the header. */
function kindsHolding(bytes: Uint8Array, needle: string): Array<number | "header"> {
  const latin1 = new TextDecoder("latin1");
  const holds = (inflated: Uint8Array) => latin1.decode(inflated).includes(needle);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { headerEnd } = parseHeader(bytes);
  const footerStart = findFooterStart(bytes, headerEnd);
  if (footerStart === null) throw new Error("expected a finalized stream");

  const kinds = new Set<number | "header">();
  if (holds(unzlibSync(bytes.subarray(HEADER_PREFIX_SIZE, headerEnd)))) kinds.add("header");
  let cursor = headerEnd;
  while (cursor < footerStart) {
    const header = readSegmentHeader(view, cursor);
    const payloadStart = cursor + SEGMENT_HEADER_SIZE;
    if (holds(unzlibSync(bytes.subarray(payloadStart, payloadStart + header.byteLength)))) {
      kinds.add(header.kind);
    }
    cursor = payloadStart + header.byteLength;
  }
  return Array.from(kinds).sort();
}

describe("a cut recording, exported", () => {
  it("holds what was added and removed inside a cut on every track before the edit", async () => {
    const bytes = await encodeRecordingToStream(take());

    expect(kindsHolding(bytes, SECRET)).toEqual(
      [
        SEGMENT_KIND.frames,
        SEGMENT_KIND.preview,
        SEGMENT_KIND.previewPatch,
        SEGMENT_KIND.workspace,
        SEGMENT_KIND.runtime,
        SEGMENT_KIND.whiteboard,
        SEGMENT_KIND.chat,
      ].sort(),
    );
  });

  // The cut used to squash only the editor frames and retime everything else, so the
  // file kept the text on every other track.
  it("keeps it only on the preview's tracks after the edit", async () => {
    const edited = applyRecordingEdit(take(), { cuts: [cut], mutes: [] });
    const bytes = await encodeRecordingToStream(edited);

    // rrweb mutations and preview events cannot be squashed (see recordingEdit.ts).
    expect(kindsHolding(bytes, SECRET)).toEqual([SEGMENT_KIND.preview, SEGMENT_KIND.previewPatch]);
  });

  it("still replays to the state the take ended in", async () => {
    const edited = applyRecordingEdit(take(), { cuts: [cut], mutes: [] });
    const decoded = decodeRecordingStream(await encodeRecordingToStream(edited));

    expect(
      decoded.workspaceEvents?.map((event) => event.snapshot.project.files["a.txt"].content),
    ).toEqual(["a", "ab", "abc"]);
    expect(decoded.workspaceEvents?.[1].snapshot.sidebarScrollTop).toBe(12);
    expect(decoded.runtimeEvents).toHaveLength(3);
    expect(decoded.chatEvents?.at(-1)?.event).toEqual({
      k: "checkpoint",
      state: {
        items: [{ kind: "message", id: "m1", role: "user", text: "hello" }],
        status: "idle",
        draft: "",
      },
    });
    expect(decoded.whiteboardEvents).toHaveLength(1);
  });
});
