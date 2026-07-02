import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../core/src";
import { decompressBinaryToRecordings } from "./recordingCodecClient";
import { RecordingStorage } from "./RecordingStorage";

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Export test recording",
    createdAt: 1_700_000_000_000,
    duration: 1000,
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "hello",
          position: { lineNumber: 1, column: 1 },
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
          viewState: null,
        },
      },
    ],
    ...overrides,
  };
}

async function exportAndDecode(recording: Recording, filename?: string): Promise<Recording> {
  const storage = new RecordingStorage();
  const downloaded: Array<{ filename: string; blob: Blob }> = [];
  vi.spyOn(
    storage as unknown as { downloadBlob: (blob: Blob, name: string) => void },
    "downloadBlob",
  ).mockImplementation((blob: Blob, name: string) => {
    downloaded.push({ filename: name, blob });
  });

  await storage.exportAsFile(recording, filename);

  const neEntry = downloaded.find((entry) => entry.filename.endsWith(".ne"));
  if (!neEntry) throw new Error("Expected a .ne download");
  const bytes = new Uint8Array(await neEntry.blob.arrayBuffer());
  const [decoded] = await decompressBinaryToRecordings(bytes);
  return decoded;
}

describe("RecordingStorage.exportAsFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips blob: cameraUrl/audioUrl before encoding — they'd defeat sibling resolution on next load", async () => {
    const recording = createRecording({
      cameraFile: "lesson.webm",
      cameraUrl: "blob:https://example.com/1234-5678",
      audioFile: "lesson.weba",
      audioUrl: "blob:https://example.com/abcd-efgh",
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.cameraUrl).toBeUndefined();
    expect(decoded.audioUrl).toBeUndefined();
    // Sibling filenames still get written so basename/same-folder resolution keeps working.
    expect(decoded.cameraFile).toBe("lesson.webm");
    expect(decoded.audioFile).toBe("lesson.weba");
  });

  it("strips data: cameraUrl/audioUrl the same way", async () => {
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "data:audio/webm;base64,AAAA",
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.audioUrl).toBeUndefined();
  });

  it("keeps a configured https:// media URL through export", async () => {
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "https://cdn.example.com/lesson-audio.weba",
      audioUrlConfigured: true,
      cameraFile: "lesson.webm",
      cameraUrl: "https://cdn.example.com/lesson-camera.webm",
      cameraUrlConfigured: true,
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.audioUrl).toBe("https://cdn.example.com/lesson-audio.weba");
    expect(decoded.audioUrlConfigured).toBe(true);
    expect(decoded.cameraUrl).toBe("https://cdn.example.com/lesson-camera.webm");
    expect(decoded.cameraUrlConfigured).toBe(true);
  });

  it("strips an unconfigured https:// URL auto-resolved from a prior ?url= load (stale-host bug)", async () => {
    // No `*UrlConfigured` flag — this is what `useUrlLoader`'s `withResolvedMediaUrls` produces,
    // not something the user set via "Configure Media Links".
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "https://old-host.example.com/lesson.weba",
      cameraFile: "lesson.webm",
      cameraUrl: "https://old-host.example.com/lesson.webm",
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.audioUrl).toBeUndefined();
    expect(decoded.cameraUrl).toBeUndefined();
    expect(decoded.audioFile).toBe("lesson.weba");
    expect(decoded.cameraFile).toBe("lesson.webm");
  });
});
