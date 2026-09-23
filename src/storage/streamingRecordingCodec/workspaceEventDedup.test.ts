import { describe, expect, it } from "vitest";
import type { Recording } from "../../core/src";
import type { WorkspaceProject, WorkspaceRecordingEvent } from "../../types/workspace";
import { createStreamingRecordingReader, decodeRecordingStream, encodeRecordingToStream } from ".";
import {
  createWorkspaceEventContentHydrator,
  createWorkspaceEventContentStripper,
} from "./workspaceEventDedup";

// A "large" base64 asset — big enough that per-event duplication would dominate
// the encoded size if the dedup ever regressed.
const ASSET_CONTENT = "QUJD".repeat(20_000); // ~80KB
const ASSET_CONTENT_V2 = "WFla".repeat(20_000);

function makeProject(assetContent: string, indexContent: string): WorkspaceProject {
  return {
    id: "project-1",
    name: "Dedup lesson",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: ["assets"],
    files: {
      "index.html": {
        path: "index.html",
        name: "index.html",
        language: "html",
        content: indexContent,
      },
      "assets/logo.png": {
        path: "assets/logo.png",
        name: "logo.png",
        language: "binary",
        content: assetContent,
        encoding: "base64",
      },
    },
  };
}

function makeWorkspaceEvent(
  timestamp: number,
  activeFilePath: string,
  assetContent: string,
  indexContent: string,
): WorkspaceRecordingEvent {
  return {
    timestamp,
    snapshot: {
      project: makeProject(assetContent, indexContent),
      activeFilePath,
      collapsedFolders: [],
      sidebarScrollTop: 0,
    },
  };
}

function makeRecording(
  workspaceEvents: WorkspaceRecordingEvent[],
  workspaceSnapshot?: WorkspaceRecordingEvent["snapshot"],
): Recording {
  return {
    workspaceSnapshot,
    version: 4,
    id: "recording-dedup",
    name: "Workspace dedup round trip",
    createdAt: 1_700_000_000_000,
    duration: 10_000,
    keyframeInterval: 120,
    frames: [],
    workspaceEvents,
    streamFinalized: true,
  };
}

const EVENTS = [
  // First event carries every file's content in full.
  makeWorkspaceEvent(0, "index.html", ASSET_CONTENT, "<h1>one</h1>"),
  // File switches: identical project — both files should dedupe away.
  makeWorkspaceEvent(2_000, "assets/logo.png", ASSET_CONTENT, "<h1>one</h1>"),
  makeWorkspaceEvent(4_000, "index.html", ASSET_CONTENT, "<h1>one</h1>"),
  // The asset changes: its new content must be carried in full again.
  makeWorkspaceEvent(6_000, "index.html", ASSET_CONTENT_V2, "<h1>one</h1>"),
  // And the changed content dedupes from then on.
  makeWorkspaceEvent(8_000, "assets/logo.png", ASSET_CONTENT_V2, "<h1>two</h1>"),
];

describe("workspace event content dedup", () => {
  it("round-trips workspace events byte-identically through encode/decode", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(EVENTS));
    const decoded = decodeRecordingStream(bytes);

    expect(decoded.workspaceEvents).toEqual(EVENTS);
    // The stream-only markers must never leak into memory.
    for (const event of decoded.workspaceEvents ?? []) {
      for (const file of Object.values(event.snapshot.project.files)) {
        expect("contentUnchanged" in file).toBe(false);
        expect("contentSplice" in file).toBe(false);
      }
    }
  });

  it("carries a lesson's collapsed file explorer through the stream", async () => {
    // The one field playback reads off the *initial* snapshot to decide where
    // the file tree starts. The dedup pass rebuilds every snapshot as it
    // strips repeated file content, so a field it forgot to carry would leave
    // the lesson opening with a tree it asked to have shut — and nothing else
    // in the round trip would notice.
    const [first, ...rest] = EVENTS;
    const events = [{ ...first, snapshot: { ...first.snapshot, sidebarCollapsed: true } }, ...rest];

    const decoded = decodeRecordingStream(await encodeRecordingToStream(makeRecording(events)));

    expect(decoded.workspaceEvents?.[0].snapshot.sidebarCollapsed).toBe(true);
    expect(decoded.workspaceEvents).toEqual(events);
  });

  it("does not grow the stream per additional unchanged-content event", async () => {
    const one = await encodeRecordingToStream(makeRecording(EVENTS.slice(0, 1)));
    const five = await encodeRecordingToStream(makeRecording(EVENTS));

    // Five events carry the ~80KB asset twice (original + changed version), never
    // five times. Everything else about the extra events is a few KB.
    expect(five.length).toBeLessThan(one.length * 2 + 20_000);
  });

  it("does not mutate the recording being encoded", async () => {
    const events = structuredClone(EVENTS);
    await encodeRecordingToStream(makeRecording(events));

    expect(events).toEqual(EVENTS);
  });

  it("hydrates identically through the incremental reader, chunk by chunk", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(EVENTS));
    const reader = createStreamingRecordingReader();

    const CHUNK = 4096;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      reader.push(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)));
    }

    const streamed = reader.getRecording();
    expect(streamed?.workspaceEvents).toEqual(EVENTS);
  });
  it("does not store the starting project twice when the header snapshot matches it", async () => {
    // The header always carries the final workspace snapshot. A lesson usually ends
    // with the files it started with, so the first event's content is a repeat.
    const finalSnapshot = EVENTS.at(-1)!.snapshot;
    const unseeded = await encodeRecordingToStream(makeRecording(EVENTS));
    const seeded = await encodeRecordingToStream(makeRecording(EVENTS, finalSnapshot));

    const decoded = decodeRecordingStream(seeded);
    expect(decoded.workspaceEvents).toEqual(EVENTS);
    expect(decoded.workspaceSnapshot).toEqual(finalSnapshot);
    // The header adds one copy of the changed asset; the seed removes the event's.
    expect(seeded.length).toBeLessThan(unseeded.length + 5_000);
  });

  it("stores a small edit to a large file as a splice, not the whole file", async () => {
    const big = Array.from({ length: 4_000 }, (_, line) => `<p>line ${line}</p>`).join("\n");
    const edited = big.replace("<p>line 2000</p>", "<p>line 2000, edited</p>");
    const events = [
      makeWorkspaceEvent(0, "index.html", ASSET_CONTENT, big),
      makeWorkspaceEvent(1_000, "assets/logo.png", ASSET_CONTENT, edited),
      makeWorkspaceEvent(2_000, "index.html", ASSET_CONTENT, big),
    ];

    const [, strippedEdit, strippedRevert] = createWorkspaceEventContentStripper()(
      events,
    ) as WorkspaceRecordingEvent[];
    expect(strippedEdit.snapshot.project.files["index.html"]).toMatchObject({
      content: "",
      contentSplice: [big.indexOf("line 2000") + "line 2000".length, 0, ", edited"],
    });
    expect(strippedRevert.snapshot.project.files["index.html"]).toMatchObject({
      content: "",
      contentSplice: [big.indexOf("line 2000") + "line 2000".length, ", edited".length, ""],
    });

    const decoded = decodeRecordingStream(await encodeRecordingToStream(makeRecording(events)));
    expect(decoded.workspaceEvents).toEqual(events);
  });

  it("keeps a short file's change as full content", () => {
    const events = [
      makeWorkspaceEvent(0, "index.html", ASSET_CONTENT, "<h1>one</h1>"),
      makeWorkspaceEvent(1_000, "index.html", ASSET_CONTENT, "<h1>two</h1>"),
    ];
    const [, stripped] = createWorkspaceEventContentStripper()(events) as WorkspaceRecordingEvent[];
    expect(stripped.snapshot.project.files["index.html"].content).toBe("<h1>two</h1>");
  });

  it("hydrates a pre-v5 stream, which was written without a seed, without one", () => {
    // v4 writers never seeded, so their first event always carries full content; a
    // seeded hydrator would still resolve it, but the reader must not rely on a
    // header snapshot a v4 writer never matched against.
    const stripped = createWorkspaceEventContentStripper()(EVENTS) as WorkspaceRecordingEvent[];
    expect(createWorkspaceEventContentHydrator()(stripped)).toEqual(EVENTS);
  });

  it("rejects a splice with no base instead of inventing content", () => {
    const [, second] = EVENTS;
    const orphan: WorkspaceRecordingEvent = {
      ...second,
      snapshot: {
        ...second.snapshot,
        project: {
          ...second.snapshot.project,
          files: {
            // Stream-only shape, as a decoder would read it off the wire.
            "index.html": {
              ...second.snapshot.project.files["index.html"],
              content: "",
              contentSplice: [0, 0, "x"],
            } as unknown as WorkspaceRecordingEvent["snapshot"]["project"]["files"][string],
          },
        },
      },
    };
    expect(() => createWorkspaceEventContentHydrator()([orphan])).toThrow(/has no base/);
  });
});
