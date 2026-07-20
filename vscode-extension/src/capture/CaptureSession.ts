import * as vscode from "vscode";
import type {
  CheckpointMeta,
  CheckpointReason,
  ContentChange,
  PatchReason,
  SelectionKind,
  SelectionRange,
  SessionEvent,
  VisibleLineRange,
} from "../model/events";
import {
  newCheckpointId,
  newSessionId,
  type DocumentId,
  type SessionId,
  type SurfaceId,
} from "../model/ids";
import { LIMITS } from "../model/limits";
import { CaptureMetrics } from "./CaptureMetrics";
import { CapturePolicy } from "./CapturePolicy";
import { installCaptureSubscriptions } from "./CaptureSubscriptions";
import {
  DocumentRegistry,
  resourceKeyOf,
  toEolMode,
  type EnrolledDocument,
} from "./DocumentRegistry";
import { EventClock } from "./EventClock";
import type { EventSink } from "./EventSink";
import { sha256Hex, utf8ByteLength } from "./hash";
import { SurfaceRegistry } from "./SurfaceRegistry";
import { TopologyTracker } from "./TopologyTracker";

type PendingViewport = {
  documentId: DocumentId;
  documentVersion: number;
  firstObservedTUs: number;
  visibleRanges: VisibleLineRange[];
  timer: ReturnType<typeof setTimeout>;
};

export type CaptureCounters = {
  patches: number;
  checkpoints: number;
  shadowMismatches: number;
  excludedDocuments: number;
};

// Phase 2 capture engine: registries + subscriptions + ordered emission.
// The Phase 5 RecordingCoordinator wraps this with the durable lifecycle.
export class CaptureSession {
  readonly sessionId: SessionId;
  readonly clock = new EventClock();
  readonly metrics = new CaptureMetrics();
  readonly documents = new DocumentRegistry();
  readonly surfaces = new SurfaceRegistry();
  readonly topology = new TopologyTracker();

  private readonly counters: CaptureCounters = {
    patches: 0,
    checkpoints: 0,
    shadowMismatches: 0,
    excludedDocuments: 0,
  };
  private readonly excludedResources = new Set<string>();
  private readonly pendingViewports = new Map<SurfaceId, PendingViewport>();
  private readonly lastSelection = new Map<SurfaceId, { json: string; seq: number }>();
  private readonly lastSurfaceEventSeq = new Map<SurfaceId, number>();
  private topologyScheduled = false;
  private topologyEarliestTUs = 0;
  private subscriptions: vscode.Disposable[] = [];
  private stopped = false;

  constructor(
    private readonly sink: EventSink,
    private readonly extensionVersion: string,
    private readonly policy: CapturePolicy = new CapturePolicy(),
    sessionId: SessionId = newSessionId(),
  ) {
    this.sessionId = sessionId;
  }

  start(): void {
    // Subscriptions first, then the initial snapshot (plan §8.1).
    this.subscriptions = installCaptureSubscriptions(this);

    this.emit("session.started", {
      sessionId: this.sessionId,
      extensionVersion: this.extensionVersion,
      vscodeVersion: vscode.version,
      platform: process.platform,
      architecture: process.arch,
    });
    this.emit("roots.snapshot", { roots: this.documents.snapshotRoots() });

    for (const editor of vscode.window.visibleTextEditors) {
      this.ensureSurface(editor);
    }
    const active = vscode.window.activeTextEditor;
    if (active) {
      const record = this.ensureSurface(active);
      if (record) {
        this.emitSurfaceEvent(record.surfaceId, "surface.focused", {
          surfaceId: record.surfaceId,
        });
      }
    }
    this.flushTopology();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    for (const disposable of this.subscriptions) {
      disposable.dispose();
    }
    this.subscriptions = [];
    for (const [surfaceId, pending] of this.pendingViewports) {
      clearTimeout(pending.timer);
      this.flushViewport(surfaceId, pending);
    }
    this.pendingViewports.clear();
    if (this.topologyScheduled) {
      this.topologyScheduled = false;
      this.flushTopology(this.topologyEarliestTUs);
    }
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  countersSnapshot(): CaptureCounters {
    return { ...this.counters };
  }

  // ---- lifecycle emission (used by the RecordingCoordinator) -----------

  /** Final checkpoints for every document dirty since its last checkpoint. */
  finalizeCheckpoints(): void {
    for (const entry of this.documents.all()) {
      if (entry.droppedReason === null && entry.shadow.transactionsSinceCheckpoint > 0) {
        this.writeCheckpoint(entry, "stop");
      }
    }
  }

  emitStopping(reason: "user" | "failure" | "shutdown"): void {
    this.emit("session.stopping", { reason });
  }

  emitFinalized(): { eventCount: number; durationUs: number } {
    const payload = {
      // This event's own seq is allocatedCount, so the total including it:
      eventCount: this.clock.allocatedCount + 1,
      durationUs: this.clock.nowUs(),
    };
    this.emit("session.finalized", payload);
    return payload;
  }

  noteOverload(queuedEvents: number, note: string): void {
    this.emit("capture.overload", { queuedEvents, note });
  }

  // ---- emission helpers ----------------------------------------------

  private emit<T extends SessionEvent["type"]>(
    type: T,
    payload: Extract<SessionEvent, { type: T }>["payload"],
    preferredTUs?: number,
  ): Extract<SessionEvent, { type: T }> {
    const stamp = preferredTUs === undefined ? this.clock.next() : this.clock.nextAt(preferredTUs);
    const event = { ...stamp, type, payload } as Extract<SessionEvent, { type: T }>;
    this.sink.append(event as SessionEvent);
    return event;
  }

  private emitSurfaceEvent<T extends SessionEvent["type"]>(
    surfaceId: SurfaceId,
    type: T,
    payload: Extract<SessionEvent, { type: T }>["payload"],
    preferredTUs?: number,
  ): void {
    // Cast: TS cannot correlate the nested generic parameter with emit's.
    const event = this.emit(type, payload as never, preferredTUs);
    this.lastSurfaceEventSeq.set(surfaceId, event.seq);
  }

  private measure<T>(name: string, fn: () => T): T {
    const startUs = this.clock.nowUs();
    try {
      return fn();
    } finally {
      this.metrics.record(name, this.clock.nowUs() - startUs);
    }
  }

  // ---- documents -------------------------------------------------------

  private enrollIfEligible(document: vscode.TextDocument): EnrolledDocument | undefined {
    const resourceKey = resourceKeyOf(document.uri);
    if (this.excludedResources.has(resourceKey)) {
      return undefined;
    }
    const existing = this.documents.get(document);
    if (existing) {
      return existing.droppedReason === null ? existing : undefined;
    }
    const decision = this.policy.evaluate(document);
    if (!decision.capture) {
      if (!this.excludedResources.has(resourceKey)) {
        this.excludedResources.add(resourceKey);
        this.counters.excludedDocuments += 1;
        this.emit("marker", {
          label: `document.excluded:${decision.schemeClass}:${decision.reason}`,
        });
      }
      return undefined;
    }
    const nowTUs = this.clock.nowUs();
    const { entry, descriptor, checkpointId } = this.documents.enroll(
      document,
      decision.schemeClass,
      nowTUs,
    );
    if (this.policy.exactSizeExceedsLimit(descriptor.byteLength)) {
      // Too large after exact measurement: the provisional registry entry
      // was never emitted and must not leak into topology snapshots.
      this.excludedResources.add(resourceKey);
      this.counters.excludedDocuments += 1;
      this.documents.forget(document);
      this.emit("marker", {
        label: `document.excluded:${decision.schemeClass}:size`,
      });
      return undefined;
    }
    this.emit("document.enrolled", { descriptor });
    this.writeCheckpoint(entry, "enrollment", checkpointId);
    return entry;
  }

  private writeCheckpoint(
    entry: EnrolledDocument,
    reason: CheckpointReason,
    checkpointId = newCheckpointId(),
  ): void {
    const meta: CheckpointMeta = {
      checkpointId,
      documentId: entry.documentId,
      reason,
      version: entry.shadow.version,
      eol: entry.shadow.eol,
      byteLength: utf8ByteLength(entry.shadow.text),
      sha256: entry.shadow.sha256,
    };
    this.sink.storeCheckpoint(meta, entry.shadow.text);
    this.emit("document.checkpoint", meta);
    entry.shadow.markCheckpoint(this.clock.nowUs());
    this.counters.checkpoints += 1;
  }

  handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    this.measure("textChange", () => {
      const entry = this.documents.get(event.document);
      if (!entry || entry.droppedReason !== null) {
        return;
      }

      const observedEol = toEolMode(event.document.eol);
      const changes: ContentChange[] = event.contentChanges.map((change) => ({
        rangeOffsetUtf16: change.rangeOffset,
        rangeLengthUtf16: change.rangeLength,
        text: change.text,
      }));

      if (changes.length === 0 && observedEol === entry.shadow.eol) {
        // A version-only bump still has to be represented in the stream or
        // the next patch's beforeVersion cannot validate during replay.
        if (entry.shadow.version !== event.document.version) {
          entry.shadow.version = event.document.version;
          this.writeCheckpoint(entry, "mismatch");
        }
        return;
      }

      const reason: PatchReason =
        event.reason === vscode.TextDocumentChangeReason.Undo
          ? "undo"
          : event.reason === vscode.TextDocumentChangeReason.Redo
            ? "redo"
            : "unknown";

      const observedText = event.document.getText();
      if (this.policy.exactSizeExceedsLimit(utf8ByteLength(observedText))) {
        // The configured limit is a capture/privacy boundary. Preserve the
        // last in-policy state, then stop this document; never checkpoint
        // the oversized post-edit text merely to describe the transition.
        this.writeCheckpoint(entry, "limit");
        entry.droppedReason = "limit";
        this.emit("marker", { label: "document.captureStopped:size-limit" });
        return;
      }
      const result = entry.shadow.applyTransaction(
        changes,
        event.document.version,
        observedText,
        observedEol,
      );

      if (!result.ok) {
        this.counters.shadowMismatches += 1;
        this.emit("capture.shadowMismatch", {
          documentId: entry.documentId,
          expectedSha256: result.expectedSha256,
          observedSha256: result.observedSha256,
          version: event.document.version,
        });
        // Shadow already reset to observed state; contain with a checkpoint.
        this.writeCheckpoint(entry, "mismatch");
        return;
      }

      const payloadBytes = changes.reduce((sum, change) => sum + utf8ByteLength(change.text), 0);

      if (changes.length === 0) {
        this.emit("document.eolChanged", {
          documentId: entry.documentId,
          eol: observedEol,
          version: event.document.version,
        });
        return;
      }

      if (payloadBytes > LIMITS.maxEventTextPayloadBytes) {
        // Never truncate a patch; a full checkpoint carries the state.
        this.writeCheckpoint(entry, "limit");
        return;
      }

      this.emit("document.patch", {
        documentId: entry.documentId,
        beforeVersion: result.beforeVersion,
        afterVersion: result.afterVersion,
        reason,
        changes,
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
        eolBefore: result.eolBefore,
        eolAfter: result.eolAfter,
      });
      this.counters.patches += 1;

      if (entry.shadow.shouldCheckpoint(this.clock.nowUs())) {
        this.writeCheckpoint(entry, "interval");
      }
    });
  }

  handleOpenTextDocument(document: vscode.TextDocument): void {
    this.measure("openDocument", () => {
      const reopened = this.documents.markReopened(document);
      if (!reopened) {
        // Never-visible documents are ignored until they become visible.
        return;
      }
      const { entry, contentChanged, languageChanged, eolChanged } = reopened;
      this.emit("document.resumed", {
        documentId: entry.documentId,
        version: document.version,
      });
      if (languageChanged) {
        this.emit("document.languageChanged", {
          documentId: entry.documentId,
          languageId: document.languageId,
        });
      }
      if (contentChanged) {
        entry.shadow.text = document.getText();
        entry.shadow.sha256 = sha256Hex(entry.shadow.text);
        entry.shadow.version = document.version;
        entry.shadow.eol = toEolMode(document.eol);
        this.writeCheckpoint(entry, "resume");
      } else {
        entry.shadow.version = document.version;
        entry.shadow.eol = toEolMode(document.eol);
        if (eolChanged) {
          this.emit("document.eolChanged", {
            documentId: entry.documentId,
            eol: entry.shadow.eol,
            version: document.version,
          });
        }
      }
    });
  }

  handleCloseTextDocument(document: vscode.TextDocument): void {
    this.measure("closeDocument", () => {
      const entry = this.documents.markClosed(document);
      if (entry) {
        this.emit("document.closed", { documentId: entry.documentId });
      }
    });
  }

  handleSaveTextDocument(document: vscode.TextDocument): void {
    this.measure("saveDocument", () => {
      const entry = this.documents.get(document);
      if (entry && entry.droppedReason === null) {
        this.emit("document.saved", {
          documentId: entry.documentId,
          version: document.version,
        });
      }
    });
  }

  handleWorkspaceFoldersChanged(): void {
    this.measure("workspaceFolders", () => {
      this.emit("roots.snapshot", { roots: this.documents.snapshotRoots() });
      this.scheduleTopology();
    });
  }

  // ---- surfaces --------------------------------------------------------

  private ensureSurface(editor: vscode.TextEditor) {
    const entry = this.enrollIfEligible(editor.document);
    if (!entry) {
      return undefined;
    }
    const known = this.surfaces.known(editor);
    const viewColumn = editor.viewColumn ?? null;
    const groupId = this.topology.groupIdForViewColumn(editor.viewColumn);
    if (known) {
      const record = this.surfaces.get(known);
      if (record) {
        const wasVisible = record.visible;
        const moved = this.surfaces.updatePlacement(record.surfaceId, groupId, viewColumn);
        record.visible = true;
        if (!wasVisible || moved) {
          this.emitSurfaceOpened(record, editor);
        }
        return record;
      }
    }
    const record = this.surfaces.register(editor, entry.documentId, groupId, viewColumn);
    this.emitSurfaceOpened(record, editor);
    return record;
  }

  private emitSurfaceOpened(
    record: ReturnType<SurfaceRegistry["register"]>,
    editor: vscode.TextEditor,
  ): void {
    this.emitSurfaceEvent(record.surfaceId, "surface.opened", {
      surfaceId: record.surfaceId,
      documentId: record.documentId,
      groupId: record.groupId,
      viewColumn: record.viewColumn,
      selections: editor.selections.map((selection) =>
        toSelectionRange(editor.document, selection),
      ),
      visibleRanges: editor.visibleRanges.map(toVisibleLineRange),
      isActive: vscode.window.activeTextEditor === editor,
    });
  }

  handleEditorViewColumnChanged(event: vscode.TextEditorViewColumnChangeEvent): void {
    this.measure("viewColumn", () => {
      this.ensureSurface(event.textEditor);
      this.scheduleTopology();
    });
  }

  handleVisibleEditorsChanged(editors: readonly vscode.TextEditor[]): void {
    this.measure("visibleEditors", () => {
      const previouslyVisible = this.surfaces.visibleSurfaceIds();
      const nowVisible = new Set<SurfaceId>();
      for (const editor of editors) {
        const record = this.ensureSurface(editor);
        if (record) {
          nowVisible.add(record.surfaceId);
        }
      }
      for (const surfaceId of previouslyVisible) {
        if (!nowVisible.has(surfaceId)) {
          this.surfaces.markHidden(surfaceId);
          this.dropPendingViewport(surfaceId);
          this.emitSurfaceEvent(surfaceId, "surface.closed", { surfaceId });
        }
      }
      this.scheduleTopology();
    });
  }

  handleActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    this.measure("activeEditor", () => {
      if (editor) {
        const record = this.ensureSurface(editor);
        if (record) {
          this.emitSurfaceEvent(record.surfaceId, "surface.focused", {
            surfaceId: record.surfaceId,
          });
        }
      }
      this.scheduleTopology();
    });
  }

  handleSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    this.measure("selection", () => {
      const record = this.ensureSurface(event.textEditor);
      if (!record) {
        return;
      }
      const selections = event.selections.map((selection) =>
        toSelectionRange(event.textEditor.document, selection),
      );
      const kind = toSelectionKind(event.kind);
      const json = JSON.stringify(selections) + kind;

      // Coalesce identical consecutive selection states only when nothing
      // else happened on this surface in between (plan §8.8).
      const last = this.lastSelection.get(record.surfaceId);
      const lastEventSeq = this.lastSurfaceEventSeq.get(record.surfaceId);
      if (last && last.json === json && last.seq === lastEventSeq) {
        return;
      }

      const payload = {
        surfaceId: record.surfaceId,
        documentId: record.documentId,
        documentVersion: event.textEditor.document.version,
        kind,
        selections,
      };
      const emitted = this.emit("surface.selectionChanged", payload);
      this.lastSurfaceEventSeq.set(record.surfaceId, emitted.seq);
      this.lastSelection.set(record.surfaceId, { json, seq: emitted.seq });
    });
  }

  handleVisibleRangesChanged(event: vscode.TextEditorVisibleRangesChangeEvent): void {
    this.measure("viewport", () => {
      const record = this.ensureSurface(event.textEditor);
      if (!record) {
        return;
      }
      const surfaceId = record.surfaceId;
      const visibleRanges = event.visibleRanges.map(toVisibleLineRange);
      const existing = this.pendingViewports.get(surfaceId);
      if (existing) {
        // Keep the first observation timestamp, latest state (plan §8.8).
        existing.visibleRanges = visibleRanges;
        existing.documentVersion = event.textEditor.document.version;
        return;
      }
      const pending: PendingViewport = {
        documentId: record.documentId,
        documentVersion: event.textEditor.document.version,
        firstObservedTUs: this.clock.nowUs(),
        visibleRanges,
        timer: setTimeout(() => {
          const current = this.pendingViewports.get(surfaceId);
          if (current) {
            this.pendingViewports.delete(surfaceId);
            this.flushViewport(surfaceId, current);
          }
        }, LIMITS.viewportCoalesceMs),
      };
      this.pendingViewports.set(surfaceId, pending);
    });
  }

  private flushViewport(surfaceId: SurfaceId, pending: PendingViewport): void {
    this.emitSurfaceEvent(
      surfaceId,
      "surface.viewportChanged",
      {
        surfaceId,
        documentId: pending.documentId,
        documentVersion: pending.documentVersion,
        visibleRanges: pending.visibleRanges,
      },
      pending.firstObservedTUs,
    );
  }

  private dropPendingViewport(surfaceId: SurfaceId): void {
    const pending = this.pendingViewports.get(surfaceId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingViewports.delete(surfaceId);
      this.flushViewport(surfaceId, pending);
    }
  }

  handleWindowStateChanged(state: vscode.WindowState): void {
    this.measure("windowState", () => {
      this.emit("window.focusChanged", { focused: state.focused });
    });
  }

  // ---- topology --------------------------------------------------------

  scheduleTopology(): void {
    if (this.topologyScheduled || this.stopped) {
      return;
    }
    this.topologyScheduled = true;
    this.topologyEarliestTUs = this.clock.nowUs();
    // Reconcile after the current burst of tab/group events (plan §8.7).
    queueMicrotask(() => {
      this.topologyScheduled = false;
      if (!this.stopped) {
        this.flushTopology(this.topologyEarliestTUs);
      }
    });
  }

  private flushTopology(preferredTUs?: number): void {
    this.measure("topology", () => {
      const result = this.topology.snapshot(this.documents);
      // The tab-group API can settle one microtask after a visible-editor
      // callback. Re-resolve placement after reconciliation so an editor
      // first observed with groupId=null receives a corrected opened event.
      for (const editor of vscode.window.visibleTextEditors) {
        this.ensureSurface(editor);
      }
      for (const unsupported of result.newUnsupported) {
        this.emit("capability.unsupportedSurface", unsupported, preferredTUs);
      }
      if (result.changed) {
        this.emit("topology.snapshot", result.payload, preferredTUs);
      }
    });
  }
}

function toSelectionRange(
  document: vscode.TextDocument,
  selection: vscode.Selection,
): SelectionRange {
  return {
    anchorOffsetUtf16: document.offsetAt(selection.anchor),
    activeOffsetUtf16: document.offsetAt(selection.active),
  };
}

function toVisibleLineRange(range: vscode.Range): VisibleLineRange {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

function toSelectionKind(kind: vscode.TextEditorSelectionChangeKind | undefined): SelectionKind {
  switch (kind) {
    case vscode.TextEditorSelectionChangeKind.Keyboard:
      return "keyboard";
    case vscode.TextEditorSelectionChangeKind.Mouse:
      return "mouse";
    case vscode.TextEditorSelectionChangeKind.Command:
      return "command";
    default:
      return "unknown";
  }
}
