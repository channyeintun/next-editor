import { describe, expect, it } from "vitest";
import type { Recording } from "../../core/src";
import type { WorkspaceProject, WorkspaceRecordingEvent } from "../../types/workspace";
import { createStreamingRecordingReader, decodeRecordingStream, encodeRecordingToStream } from ".";

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

function makeRecording(workspaceEvents: WorkspaceRecordingEvent[]): Recording {
  return {
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
    // The stream-only `contentUnchanged` marker must never leak into memory.
    for (const event of decoded.workspaceEvents ?? []) {
      for (const file of Object.values(event.snapshot.project.files)) {
        expect("contentUnchanged" in file).toBe(false);
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
});
