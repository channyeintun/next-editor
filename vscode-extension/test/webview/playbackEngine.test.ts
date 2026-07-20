import { describe, expect, it } from "vitest";
import type {
  ContentChange,
  EolMode,
  SelectionRange,
  SessionEvent,
  VisibleLineRange,
} from "../../src/model/events";
import type { Bridge } from "../../src/webview/bridge/acquireBridge";
import type {
  HostToWebviewMessage,
  RecordingMetadataPayload,
  WebviewToHostMessage,
} from "../../src/webview/bridge/protocol";
import { PlaybackEngine } from "../../src/webview/player/PlaybackEngine";
import { applyContentChanges } from "../../src/webview/player/PlaybackState";
import type { PlaybackRenderer } from "../../src/webview/player/Renderer";

class TestBridge implements Bridge {
  private handler: ((message: HostToWebviewMessage) => void) | null = null;
  private persisted: unknown;
  private readonly heldCheckpointRequests = new Map<
    string,
    Extract<WebviewToHostMessage, { type: "recording.requestCheckpoint" }>
  >();

  constructor(
    private readonly events: SessionEvent[],
    private readonly checkpoints: ReadonlyMap<string, string>,
    private readonly heldCheckpoints = new Set<string>(),
  ) {}

  post(message: WebviewToHostMessage): void {
    if (message.type === "recording.requestWindow") {
      const events = this.events.slice(message.fromSeq, message.fromSeq + message.maxCount);
      this.emit({
        type: "recording.eventWindow",
        requestId: message.requestId,
        fromSeq: message.fromSeq,
        events,
        done: message.fromSeq + events.length >= this.events.length,
      });
    } else if (message.type === "recording.requestCheckpoint") {
      if (this.heldCheckpoints.has(message.checkpointId)) {
        this.heldCheckpointRequests.set(message.checkpointId, message);
      } else {
        this.replyWithCheckpoint(message);
      }
    }
  }

  onMessage(handler: (message: HostToWebviewMessage) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  getState(): unknown {
    return this.persisted;
  }

  setState(state: unknown): void {
    this.persisted = state;
  }

  emit(message: HostToWebviewMessage): void {
    this.handler?.(message);
  }

  resolveCheckpoint(checkpointId: string): void {
    const request = this.heldCheckpointRequests.get(checkpointId);
    if (!request) {
      throw new Error(`no held request for ${checkpointId}`);
    }
    this.heldCheckpointRequests.delete(checkpointId);
    this.replyWithCheckpoint(request);
  }

  private replyWithCheckpoint(
    request: Extract<WebviewToHostMessage, { type: "recording.requestCheckpoint" }>,
  ): void {
    const text = this.checkpoints.get(request.checkpointId);
    if (text === undefined) {
      this.emit({
        type: "request.failed",
        requestId: request.requestId,
        message: `missing checkpoint ${request.checkpointId}`,
      });
      return;
    }
    this.emit({
      type: "recording.checkpoint",
      requestId: request.requestId,
      documentId: request.documentId,
      checkpointId: request.checkpointId,
      text,
    });
  }
}

class TestRenderer implements PlaybackRenderer {
  readonly id = "monaco" as const;
  readonly documents = new Map<string, { text: string; languageId: string }>();
  readonly eols = new Map<string, EolMode>();
  private readonly surfaces = new Set<string>();

  createDocument(documentId: string, text: string, languageId: string): void {
    this.documents.set(documentId, { text, languageId });
  }

  disposeDocument(documentId: string): void {
    this.documents.delete(documentId);
    this.eols.delete(documentId);
  }

  setDocumentLanguage(documentId: string, languageId: string): void {
    const document = this.document(documentId);
    document.languageId = languageId;
  }

  setDocumentEol(documentId: string, eol: EolMode): void {
    this.eols.set(documentId, eol);
  }

  applyChanges(documentId: string, changes: readonly ContentChange[]): void {
    const document = this.document(documentId);
    document.text = applyContentChanges(document.text, changes);
  }

  setDocumentText(documentId: string, text: string): void {
    this.document(documentId).text = text;
  }

  getDocumentText(documentId: string): string {
    return this.document(documentId).text;
  }

  createSurface(surfaceId: string, _documentId: string, _container: HTMLElement): void {
    this.surfaces.add(surfaceId);
  }

  hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  disposeSurface(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
  }

  setSelections(_surfaceId: string, _selections: readonly SelectionRange[]): void {}

  setViewport(_surfaceId: string, _visibleRanges: readonly VisibleLineRange[]): void {}

  suspendSurface(_surfaceId: string): void {}

  resumeSurface(_surfaceId: string, _container: HTMLElement): void {}

  dispose(): void {
    this.documents.clear();
    this.eols.clear();
    this.surfaces.clear();
  }

  private document(documentId: string): { text: string; languageId: string } {
    const document = this.documents.get(documentId);
    if (!document) {
      throw new Error(`renderer document missing: ${documentId}`);
    }
    return document;
  }
}

function metadata(events: SessionEvent[], durationUs: number): RecordingMetadataPayload {
  return {
    fileName: "fixture.nextrecording",
    sessionId: "session-1",
    durationUs,
    eventCount: events.length,
    hasAudio: false,
    defaultSpeed: 1,
    documents: [
      {
        documentId: "doc-1",
        displayName: "one.txt",
        logicalPath: "one.txt",
        languageId: "plaintext",
      },
    ],
    workspaceRoots: [],
  };
}

function started(seq: number, tUs: number): SessionEvent {
  return {
    seq,
    tUs,
    type: "session.started",
    payload: {
      sessionId: "session-1",
      extensionVersion: "test",
      vscodeVersion: "test",
      platform: "test",
      architecture: "test",
    },
  } as SessionEvent;
}

function enrolled(seq: number, tUs: number): SessionEvent {
  return {
    seq,
    tUs,
    type: "document.enrolled",
    payload: {
      descriptor: {
        documentId: "doc-1",
        rootId: null,
        logicalPath: "one.txt",
        displayName: "one.txt",
        schemeClass: "untitled",
        languageId: "plaintext",
        eol: "LF",
        initialVersion: 1,
        initialCheckpointId: "cp0",
        byteLength: 3,
        sha256: "",
      },
    },
  } as SessionEvent;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}

describe("PlaybackEngine", () => {
  it("applies state-carrying checkpoints, language changes, and recorded group placement", async () => {
    const events = [
      started(0, 0),
      enrolled(1, 1),
      {
        seq: 2,
        tUs: 1,
        type: "document.checkpoint",
        payload: {
          checkpointId: "cp0",
          documentId: "doc-1",
          reason: "enrollment",
          version: 1,
          eol: "LF",
          byteLength: 3,
          sha256: "",
        },
      },
      {
        seq: 3,
        tUs: 2,
        type: "document.resumed",
        payload: { documentId: "doc-1", version: 7 },
      },
      {
        seq: 4,
        tUs: 2,
        type: "document.checkpoint",
        payload: {
          checkpointId: "cp-resume",
          documentId: "doc-1",
          reason: "resume",
          version: 7,
          eol: "LF",
          byteLength: 5,
          sha256: "",
        },
      },
      {
        seq: 5,
        tUs: 3,
        type: "document.eolChanged",
        payload: { documentId: "doc-1", eol: "CRLF", version: 8 },
      },
      {
        seq: 6,
        tUs: 3,
        type: "document.languageChanged",
        payload: { documentId: "doc-1", languageId: "typescript" },
      },
      {
        seq: 7,
        tUs: 4,
        type: "surface.opened",
        payload: {
          surfaceId: "surface-1",
          documentId: "doc-1",
          groupId: "group-1",
          viewColumn: 1,
          selections: [],
          visibleRanges: [],
          isActive: true,
        },
      },
      {
        seq: 8,
        tUs: 4,
        type: "surface.opened",
        payload: {
          surfaceId: "surface-2",
          documentId: "doc-1",
          groupId: "group-2",
          viewColumn: 2,
          selections: [],
          visibleRanges: [],
          isActive: false,
        },
      },
      {
        seq: 9,
        tUs: 5,
        type: "session.finalized",
        payload: { eventCount: 10, durationUs: 5 },
      },
    ] as SessionEvent[];
    const bridge = new TestBridge(
      events,
      new Map([
        ["cp0", "abc"],
        ["cp-resume", "world"],
      ]),
    );
    const renderer = new TestRenderer();
    const engine = new PlaybackEngine(bridge, renderer);

    bridge.emit({ type: "recording.metadata", payload: metadata(events, 5) });
    await waitUntil(() => engine.getSnapshot().phase === "ready");
    await engine.seekTo(5);

    expect(renderer.documents.get("doc-1")).toEqual({
      text: "world",
      languageId: "typescript",
    });
    expect(engine.reducer.state.documents.get("doc-1")?.version).toBe(8);
    expect(engine.reducer.state.documents.get("doc-1")?.eol).toBe("CRLF");
    expect(renderer.eols.get("doc-1")).toBe("CRLF");
    expect(engine.surfaceForGroupDocument("group-2", "doc-1")).toBe("surface-2");
    expect(engine.surfaceForGroupDocument("group-1", "doc-1")).toBe("surface-1");
    engine.dispose();
  });

  it("prevents an older asynchronous seek from overwriting a newer one", async () => {
    const events = [
      started(0, 0),
      enrolled(1, 1),
      {
        seq: 2,
        tUs: 1,
        type: "document.checkpoint",
        payload: {
          checkpointId: "cp0",
          documentId: "doc-1",
          reason: "enrollment",
          version: 1,
          eol: "LF",
          byteLength: 3,
          sha256: "",
        },
      },
      {
        seq: 3,
        tUs: 10,
        type: "document.patch",
        payload: {
          documentId: "doc-1",
          beforeVersion: 1,
          afterVersion: 2,
          reason: "unknown",
          changes: [{ rangeOffsetUtf16: 0, rangeLengthUtf16: 3, text: "A" }],
          beforeHash: "",
          afterHash: "",
          eolBefore: "LF",
          eolAfter: "LF",
        },
      },
      {
        seq: 4,
        tUs: 11,
        type: "document.checkpoint",
        payload: {
          checkpointId: "cpA",
          documentId: "doc-1",
          reason: "interval",
          version: 2,
          eol: "LF",
          byteLength: 1,
          sha256: "",
        },
      },
      {
        seq: 5,
        tUs: 20,
        type: "document.patch",
        payload: {
          documentId: "doc-1",
          beforeVersion: 2,
          afterVersion: 3,
          reason: "unknown",
          changes: [{ rangeOffsetUtf16: 0, rangeLengthUtf16: 1, text: "B" }],
          beforeHash: "",
          afterHash: "",
          eolBefore: "LF",
          eolAfter: "LF",
        },
      },
      {
        seq: 6,
        tUs: 21,
        type: "document.checkpoint",
        payload: {
          checkpointId: "cpB",
          documentId: "doc-1",
          reason: "interval",
          version: 3,
          eol: "LF",
          byteLength: 1,
          sha256: "",
        },
      },
      {
        seq: 7,
        tUs: 30,
        type: "session.finalized",
        payload: { eventCount: 8, durationUs: 30 },
      },
    ] as SessionEvent[];
    const bridge = new TestBridge(
      events,
      new Map([
        ["cp0", "abc"],
        ["cpA", "A"],
        ["cpB", "B"],
      ]),
      new Set(["cpA", "cpB"]),
    );
    const renderer = new TestRenderer();
    const engine = new PlaybackEngine(bridge, renderer);

    bridge.emit({ type: "recording.metadata", payload: metadata(events, 30) });
    await waitUntil(() => engine.getSnapshot().phase === "ready");
    await engine.seekTo(30);
    expect(renderer.getDocumentText("doc-1")).toBe("B");

    const olderSeek = engine.seekTo(11);
    const newerSeek = engine.seekTo(21);
    bridge.resolveCheckpoint("cpB");
    await newerSeek;
    bridge.resolveCheckpoint("cpA");
    await olderSeek;

    expect(engine.getSnapshot().playheadUs).toBe(21);
    expect(renderer.getDocumentText("doc-1")).toBe("B");
    engine.dispose();
  });
});
