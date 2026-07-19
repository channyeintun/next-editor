import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { CONTEXT_KEYS } from "../model/ids";
import { validateSessionEventRaw } from "../model/schemas";
import { CheckpointStore } from "../storage/CheckpointStore";
import { readJournal } from "../storage/JournalReader";
import { OrderedJournalWriter } from "../storage/OrderedJournalWriter";
import { atomicWriteJson } from "../storage/atomicFile";
import { validateSessionReplay } from "../storage/replayValidation";
import { SessionMetadataStore } from "../storage/SessionMetadataStore";
import { SessionPaths } from "../storage/SessionPaths";
import { newSessionId } from "../model/ids";
import { CapturePolicy } from "./CapturePolicy";
import { CaptureSession } from "./CaptureSession";
import { DurableSessionSink } from "./DurableSessionSink";

export type CoordinatorState = "idle" | "preparing" | "recording" | "stopping" | "finalizing";

export type StartResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: "already-active" | "failed"; message: string };

export type StopResult =
  | {
      ok: true;
      sessionId: string;
      eventCount: number;
      durationUs: number;
      patches: number;
      checkpoints: number;
      shadowMismatches: number;
      sessionDir: string;
    }
  | { ok: false; code: "not-recording" | "failed"; message: string };

type ActiveRecording = {
  session: CaptureSession;
  journal: OrderedJournalWriter;
  checkpoints: CheckpointStore;
  paths: SessionPaths;
  metadata: SessionMetadataStore;
};

// Explicit lifecycle (plan §8.1):
// idle → preparing → recording → stopping → finalizing → idle
// any active state → failed (recorded in metadata; coordinator returns to
// idle and leaves the session directory recoverable).
export class RecordingCoordinator {
  private stateValue: CoordinatorState = "idle";
  private active: ActiveRecording | null = null;
  private stopPromise: Promise<StopResult> | null = null;
  private readonly stateEmitter = new vscode.EventEmitter<CoordinatorState>();
  readonly onDidChangeState = this.stateEmitter.event;
  lastError: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get state(): CoordinatorState {
    return this.stateValue;
  }

  get activeSessionDir(): string | null {
    return this.active?.paths.sessionDir ?? null;
  }

  get activeSessionId(): string | null {
    return this.active?.session.sessionId ?? null;
  }

  private setState(state: CoordinatorState): void {
    this.stateValue = state;
    // Context keys drive menus/status; only after successful transitions.
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_KEYS.isPreparing,
      state === "preparing",
    );
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_KEYS.isRecording,
      state === "recording",
    );
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_KEYS.isStopping,
      state === "stopping" || state === "finalizing",
    );
    this.stateEmitter.fire(state);
  }

  async start(): Promise<StartResult> {
    if (this.stateValue !== "idle") {
      return {
        ok: false,
        code: "already-active",
        message: `a recording is already ${this.stateValue}`,
      };
    }
    this.setState("preparing");
    const storageRoot = this.context.globalStorageUri.fsPath;
    let recording: ActiveRecording | null = null;
    try {
      const extensionVersion = String(this.context.extension.packageJSON.version ?? "0");
      const policy = CapturePolicy.fromConfiguration();
      const sessionId = newSessionId();
      const paths = new SessionPaths(storageRoot, sessionId);
      await fs.mkdir(paths.checkpointsDir, { recursive: true });
      const metadata = SessionMetadataStore.createInitial(paths, {
        extensionVersion,
        vscodeVersion: vscode.version,
      });
      await metadata.update({ state: "preparing" });

      let session: CaptureSession | null = null;
      const journal = await OrderedJournalWriter.open(paths.journalFile, {
        onOverload: (queuedBytes) => session?.noteOverload(queuedBytes, "journal queue over limit"),
        onError: (error) => {
          this.lastError = `journal write failure: ${error.message}`;
        },
      });
      const checkpoints = new CheckpointStore(paths.checkpointsDir);
      const sink = new DurableSessionSink(journal, checkpoints);
      session = new CaptureSession(sink, extensionVersion, policy, sessionId);

      recording = { session, journal, checkpoints, paths, metadata };
      session.start();
      await metadata.update({ state: "recording" });
      this.active = recording;
      this.setState("recording");
      return { ok: true, sessionId: session.sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      if (recording) {
        recording.session.stop();
        await recording.journal.close().catch(() => {});
        await recording.metadata
          .update({
            state: "failed",
            failure: { message, at: new Date().toISOString() },
          })
          .catch(() => {});
      }
      this.active = null;
      this.setState("idle");
      return { ok: false, code: "failed", message };
    }
  }

  stop(): Promise<StopResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.active || this.stateValue !== "recording") {
      return Promise.resolve({
        ok: false,
        code: "not-recording",
        message: "no active recording",
      });
    }
    this.stopPromise = this.doStop(this.active).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async doStop(recording: ActiveRecording): Promise<StopResult> {
    const { session, journal, paths, metadata } = recording;
    try {
      this.setState("stopping");
      await metadata.update({ state: "stopping" });

      // 1. Remove subscriptions / flush coalesced state at a boundary.
      session.stop();
      // 2. Final checkpoints for dirty documents, then the stop marker.
      session.finalizeCheckpoints();
      session.emitStopping("user");
      // 3. Drain the ordered writer (checkpoint barriers included).
      await journal.drain();

      this.setState("finalizing");
      await metadata.update({
        state: "finalizing",
        lastDurableSeq: journal.lastDurableSeq,
      });

      // 4. Validate the complete working session by replaying it.
      const journalRead = await readJournal(paths.journalFile, validateSessionEventRaw);
      if (journalRead.corruption) {
        throw new Error(
          `journal corruption at line ${journalRead.corruption.line}: ${journalRead.corruption.message}`,
        );
      }
      const checkpointTexts = new Map<string, string>();
      for (const id of await recording.checkpoints.list()) {
        checkpointTexts.set(id, await recording.checkpoints.read(id));
      }
      const validation = validateSessionReplay(journalRead.events, (id) => checkpointTexts.get(id));
      if (!validation.ok) {
        throw new Error(
          `session validation failed: ${validation.errors.slice(0, 3).join("; ")}` +
            (validation.errors.length > 3 ? ` (+${validation.errors.length - 3} more)` : ""),
        );
      }

      // 5. Record the finalized marker event and make it durable.
      const finalized = session.emitFinalized();
      await journal.close();

      await atomicWriteJson(paths.finalizedFile, {
        finalizedAt: new Date().toISOString(),
        eventCount: finalized.eventCount,
        durationUs: finalized.durationUs,
        validatedEventCount: journalRead.events.length,
        documents: [...validation.finalDocuments.entries()].map(([id, doc]) => ({
          documentId: id,
          sha256: doc.sha256,
          version: doc.version,
        })),
      });
      await metadata.update({
        state: "finalized",
        lastDurableSeq: journal.lastDurableSeq,
      });

      const counters = session.countersSnapshot();
      this.active = null;
      this.setState("idle");
      return {
        ok: true,
        sessionId: session.sessionId,
        eventCount: finalized.eventCount,
        durationUs: finalized.durationUs,
        patches: counters.patches,
        checkpoints: counters.checkpoints,
        shadowMismatches: counters.shadowMismatches,
        sessionDir: paths.sessionDir,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      session.stop();
      await journal.close().catch(() => {});
      await metadata
        .update({
          state: "failed",
          failure: { message, at: new Date().toISOString() },
        })
        .catch(() => {});
      this.active = null;
      this.setState("idle");
      return { ok: false, code: "failed", message };
    }
  }

  /**
   * Test-only crash simulation: abandon the active session without any
   * cleanup writes, as an extension-host crash would.
   */
  abandonForTest(): string | null {
    const dir = this.active?.paths.sessionDir ?? null;
    if (this.active) {
      this.active.session.stop();
      this.active = null;
      this.setState("idle");
    }
    return dir;
  }

  /** Best-effort shutdown; durable recovery handles the rest (plan §9.8). */
  dispose(): void {
    if (this.active) {
      this.active.session.stop();
      void this.active.journal.close().catch(() => {});
    }
    this.stateEmitter.dispose();
  }
}
