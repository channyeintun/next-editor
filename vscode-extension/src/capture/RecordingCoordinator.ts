import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { createActor, type Actor } from "xstate";
import { CONTEXT_KEYS, newSessionId, type SessionId } from "../model/ids";
import { validateSessionEventRaw } from "../model/schemas";
import { CheckpointStore } from "../storage/CheckpointStore";
import { readJournal } from "../storage/JournalReader";
import { OrderedJournalWriter } from "../storage/OrderedJournalWriter";
import { atomicWriteJson } from "../storage/atomicFile";
import { writeArtifact } from "../storage/ArtifactWriter";
import { RecordingLibrary } from "../storage/RecordingLibrary";
import { validateSessionReplayAsync } from "../storage/replayValidation";
import { SessionMetadataStore } from "../storage/SessionMetadataStore";
import { SessionPaths } from "../storage/SessionPaths";
import { CapturePolicy } from "./CapturePolicy";
import { CaptureSession } from "./CaptureSession";
import { DurableSessionSink } from "./DurableSessionSink";
import {
  recordingCoordinatorMachine,
  type RecordingMachineContext,
  type RecordingMachineState,
  type RecordingStopReason,
} from "./recordingCoordinatorMachine";

export type CoordinatorState = RecordingMachineState;

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
      artifactPath: string;
    }
  | { ok: false; code: "not-recording" | "failed"; message: string };

type ActiveRecording = {
  session: CaptureSession;
  journal: OrderedJournalWriter;
  checkpoints: CheckpointStore;
  paths: SessionPaths;
  metadata: SessionMetadataStore;
};

// XState owns legal lifecycle transitions; this facade owns the VS Code and
// filesystem effects entered by those states. It is a fresh extension-only
// machine and deliberately imports no main-app machine implementation.
export class RecordingCoordinator {
  private readonly actor: Actor<typeof recordingCoordinatorMachine>;
  private readonly actorSubscription: { unsubscribe(): void };
  private stateValue: CoordinatorState = "idle";
  private active: ActiveRecording | null = null;
  private startResolver: ((result: StartResult) => void) | null = null;
  private stopPromise: Promise<StopResult> | null = null;
  private stopResolver: ((result: StopResult) => void) | null = null;
  private notifyUnhandledFailure = false;
  private disposed = false;
  private readonly stateEmitter = new vscode.EventEmitter<CoordinatorState>();
  readonly onDidChangeState = this.stateEmitter.event;
  lastError: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.actor = createActor(recordingCoordinatorMachine);
    this.actorSubscription = this.actor.subscribe((snapshot) => {
      this.enterMachineState(snapshot.value as RecordingMachineState, snapshot.context);
    });
    this.actor.start();
  }

  get state(): CoordinatorState {
    return this.stateValue;
  }

  get activeSessionDir(): string | null {
    return this.active?.paths.sessionDir ?? null;
  }

  get activeSessionId(): string | null {
    return this.active?.session.sessionId ?? null;
  }

  private enterMachineState(
    state: RecordingMachineState,
    machineContext: RecordingMachineContext,
  ): void {
    if (state === this.stateValue && state !== "idle") {
      return;
    }

    // Stopping is the capture boundary: remove subscriptions and enqueue
    // final state synchronously before publishing UI state or awaiting I/O.
    if (state === "stopping") {
      const recording = this.active;
      const sessionId = machineContext.sessionId;
      const reason = machineContext.stopReason;
      if (!recording || !sessionId || !reason || recording.session.sessionId !== sessionId) {
        if (sessionId) {
          this.failSession(sessionId, "recording resources missing at stop boundary", false);
        }
        return;
      }
      try {
        recording.session.stop();
        recording.session.finalizeCheckpoints();
        recording.session.emitStopping(reason);
      } catch (error) {
        this.failSession(sessionId, errorMessage(error), false);
        return;
      }
      this.publishState(state);
      void this.drainStoppedSession(recording, sessionId);
      return;
    }

    if (state === "failed") {
      // Failure must also stop accepting capture events synchronously.
      try {
        this.active?.session.stop();
      } catch {
        // The recorded storage error remains the lifecycle authority.
      }
      this.publishState(state);
      const sessionId = machineContext.sessionId;
      if (sessionId) {
        void this.cleanupFailedSession(sessionId, machineContext.failureMessage);
      }
      return;
    }

    this.publishState(state);
    switch (state) {
      case "idle":
        break;
      case "preparing": {
        const sessionId = machineContext.sessionId;
        if (sessionId) {
          void this.prepareSession(sessionId);
        }
        break;
      }
      case "recording": {
        const sessionId = machineContext.sessionId;
        const recording = this.active;
        if (!sessionId || !recording || recording.session.sessionId !== sessionId) {
          if (sessionId) {
            this.failSession(sessionId, "recording resources missing after preparation", false);
          }
          return;
        }
        this.completeStart({ ok: true, sessionId });
        if (machineContext.pendingOverloadBytes !== null) {
          const queuedBytes = machineContext.pendingOverloadBytes;
          queueMicrotask(() => {
            if (this.stateValue === "recording" && this.active === recording) {
              this.requestAutomaticOverloadStop(queuedBytes);
            }
          });
        }
        break;
      }
      case "finalizing": {
        const sessionId = machineContext.sessionId;
        const recording = this.active;
        if (!sessionId || !recording || recording.session.sessionId !== sessionId) {
          if (sessionId) {
            this.failSession(sessionId, "recording resources missing during finalization", false);
          }
          return;
        }
        void this.finalizeSession(recording, sessionId);
        break;
      }
    }
  }

  private publishState(state: CoordinatorState): void {
    if (state === this.stateValue && state !== "idle") {
      return;
    }
    this.stateValue = state;
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
      state === "stopping" || state === "finalizing" || state === "failed",
    );
    if (!this.disposed) {
      this.stateEmitter.fire(state);
    }
  }

  async start(): Promise<StartResult> {
    if (this.disposed) {
      return { ok: false, code: "failed", message: "recording coordinator is disposed" };
    }
    if (this.stateValue !== "idle") {
      return {
        ok: false,
        code: "already-active",
        message: `a recording is already ${this.stateValue}`,
      };
    }

    this.lastError = null;
    this.notifyUnhandledFailure = false;
    const sessionId = newSessionId();
    const startPromise = new Promise<StartResult>((resolve) => {
      this.startResolver = resolve;
    });
    this.actor.send({ type: "START", sessionId });
    // Read through the getter: the send() above synchronously re-enters
    // publishState, so the local narrowing of stateValue is stale here.
    if (this.state !== "preparing") {
      this.completeStart({
        ok: false,
        code: "failed",
        message: "recording machine rejected the start transition",
      });
    }
    return startPromise;
  }

  private async prepareSession(sessionId: string): Promise<void> {
    const storageRoot = this.context.globalStorageUri.fsPath;
    let recording: ActiveRecording | null = null;
    let metadata: SessionMetadataStore | null = null;
    let journal: OrderedJournalWriter | null = null;
    let session: CaptureSession | null = null;
    let pendingOverloadBytes: number | null = null;

    try {
      const extensionVersion = String(this.context.extension.packageJSON.version ?? "0");
      const policy = CapturePolicy.fromConfiguration();
      const paths = new SessionPaths(storageRoot, sessionId);
      await fs.mkdir(paths.checkpointsDir, { recursive: true });
      this.throwIfDisposed();

      metadata = SessionMetadataStore.createInitial(paths, {
        extensionVersion,
        vscodeVersion: vscode.version,
      });
      await metadata.update({ state: "preparing" });
      this.throwIfDisposed();

      journal = await OrderedJournalWriter.open(paths.journalFile, {
        onOverload: (queuedBytes) => {
          session?.noteOverload(queuedBytes, "journal queue over limit");
          const peakQueuedBytes = Math.max(pendingOverloadBytes ?? 0, queuedBytes);
          pendingOverloadBytes = peakQueuedBytes;
          if (recording && this.active === recording && this.stateValue === "recording") {
            this.requestAutomaticOverloadStop(peakQueuedBytes);
          }
        },
        onError: (error) => {
          const message = `journal write failure: ${error.message}`;
          this.lastError = message;
          if (recording && this.active === recording && this.stateValue === "recording") {
            this.failSession(sessionId, message, true);
          }
        },
      });
      const checkpoints = new CheckpointStore(paths.checkpointsDir);
      const sink = new DurableSessionSink(journal, checkpoints);
      // The id originated from newSessionId(); the machine context widens
      // the brand to string on the round trip.
      session = new CaptureSession(sink, extensionVersion, policy, sessionId as SessionId);
      recording = { session, journal, checkpoints, paths, metadata };
      this.active = recording;

      session.start();
      // Initial snapshots/checkpoints are durable before entering recording.
      await journal.drain();
      await metadata.update({ state: "recording" });
      if (journal.error) {
        throw journal.error;
      }
      this.throwIfDisposed();
      if (!this.isCurrentMachineSession("preparing", sessionId)) {
        throw new Error("recording preparation was superseded");
      }
      this.actor.send({ type: "PREPARED", sessionId, pendingOverloadBytes });
    } catch (error) {
      const message = errorMessage(error);
      this.lastError = message;
      try {
        session?.stop();
      } catch {
        // Preserve the original preparation failure.
      }
      await journal?.close().catch(() => {});
      await metadata
        ?.update({
          state: "failed",
          failure: { message, at: new Date().toISOString() },
          lastDurableSeq: journal?.lastDurableSeq ?? -1,
        })
        .catch(() => {});
      if (this.active === recording) {
        this.active = null;
      }
      if (this.isCurrentMachineSession("preparing", sessionId)) {
        this.actor.send({ type: "PREPARE_FAILED", sessionId, message });
      }
    }
  }

  stop(): Promise<StopResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    return this.requestStop("user");
  }

  private requestStop(reason: RecordingStopReason, overloadBytes?: number): Promise<StopResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const recording = this.active;
    if (!recording || this.stateValue !== "recording") {
      return Promise.resolve({
        ok: false,
        code: "not-recording",
        message: "no active recording",
      });
    }

    const sessionId = recording.session.sessionId;
    const stopPromise = new Promise<StopResult>((resolve) => {
      this.stopResolver = resolve;
    });
    this.stopPromise = stopPromise;
    this.actor.send({ type: "STOP", sessionId, reason, overloadBytes });
    // Getter read: send() synchronously updates stateValue (see start()).
    if (this.state !== "stopping") {
      this.completeStop({
        ok: false,
        code: "failed",
        message: "recording machine rejected the stop transition",
      });
    }
    return stopPromise;
  }

  private requestAutomaticOverloadStop(queuedBytes: number): void {
    if (this.stateValue !== "recording") {
      return;
    }
    const stop = this.requestStop("failure", queuedBytes);
    void stop.then((result) => {
      if (result.ok) {
        void vscode.window.showWarningMessage(
          `Next Recording stopped early because storage could not keep up (${Math.ceil(queuedBytes / 1048576)} MiB queued). The recording was saved.`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `Next Recording could not be saved after a storage overload: ${result.message}`,
        );
      }
    });
  }

  private async drainStoppedSession(recording: ActiveRecording, sessionId: string): Promise<void> {
    try {
      await recording.metadata.update({ state: "stopping" });
      await recording.journal.drain();
      if (this.isCurrentMachineSession("stopping", sessionId)) {
        this.actor.send({ type: "DRAINED", sessionId });
      }
    } catch (error) {
      this.failSession(sessionId, errorMessage(error), false);
    }
  }

  private async finalizeSession(recording: ActiveRecording, sessionId: string): Promise<void> {
    const { session, journal, paths, metadata } = recording;
    try {
      await metadata.update({
        state: "finalizing",
        lastDurableSeq: journal.lastDurableSeq,
      });

      const journalRead = await readJournal(paths.journalFile, validateSessionEventRaw);
      if (journalRead.corruption) {
        throw new Error(
          `journal corruption at line ${journalRead.corruption.line}: ${journalRead.corruption.message}`,
        );
      }
      const validation = await validateSessionReplayAsync(journalRead.events, async (id) => {
        try {
          return await recording.checkpoints.read(id);
        } catch {
          return undefined;
        }
      });
      if (!validation.ok) {
        throw new Error(
          `session validation failed: ${validation.errors.slice(0, 3).join("; ")}` +
            (validation.errors.length > 3 ? ` (+${validation.errors.length - 3} more)` : ""),
        );
      }

      const finalized = session.emitFinalized();
      await journal.close();

      const library = new RecordingLibrary(this.context.globalStorageUri.fsPath);
      const artifactPath = library.artifactPathFor(session.sessionId, new Date());
      const artifact = await writeArtifact({
        paths,
        metadata: metadata.metadata,
        outputPath: artifactPath,
      });

      await atomicWriteJson(paths.finalizedFile, {
        finalizedAt: new Date().toISOString(),
        eventCount: finalized.eventCount,
        durationUs: finalized.durationUs,
        validatedEventCount: journalRead.events.length,
        artifactPath: artifact.artifactPath,
        documents: [...validation.finalDocuments.entries()].map(([id, doc]) => ({
          documentId: id,
          sha256: doc.sha256,
          version: doc.version,
        })),
      });
      await metadata.update({
        state: "finalized",
        lastDurableSeq: journal.lastDurableSeq,
        artifactPath: artifact.artifactPath,
      });

      const counters = session.countersSnapshot();
      const result: StopResult = {
        ok: true,
        sessionId,
        eventCount: finalized.eventCount,
        durationUs: finalized.durationUs,
        patches: counters.patches,
        checkpoints: counters.checkpoints,
        shadowMismatches: counters.shadowMismatches,
        sessionDir: paths.sessionDir,
        artifactPath: artifact.artifactPath,
      };
      if (this.active === recording) {
        this.active = null;
      }
      if (this.isCurrentMachineSession("finalizing", sessionId)) {
        this.completeStop(result);
        this.actor.send({ type: "FINALIZED", sessionId });
      }
    } catch (error) {
      this.failSession(sessionId, errorMessage(error), false);
    }
  }

  private failSession(sessionId: string, message: string, notify: boolean): void {
    this.lastError = message;
    this.notifyUnhandledFailure ||= notify;
    const snapshot = this.actor.getSnapshot();
    if (
      snapshot.context.sessionId === sessionId &&
      snapshot.value !== "idle" &&
      snapshot.value !== "failed"
    ) {
      this.actor.send({ type: "FAIL", sessionId, message });
    }
  }

  private async cleanupFailedSession(
    sessionId: string,
    machineMessage: string | null,
  ): Promise<void> {
    const recording = this.active?.session.sessionId === sessionId ? this.active : null;
    const message = machineMessage ?? this.lastError ?? "recording failed";
    if (recording) {
      await recording.journal.close().catch(() => {});
      await recording.metadata
        .update({
          state: "failed",
          failure: { message, at: new Date().toISOString() },
          lastDurableSeq: recording.journal.lastDurableSeq,
        })
        .catch(() => {});
      if (this.active === recording) {
        this.active = null;
      }
    }

    this.completeStart({ ok: false, code: "failed", message });
    this.completeStop({ ok: false, code: "failed", message });
    if (this.isCurrentMachineSession("failed", sessionId)) {
      this.actor.send({ type: "CLEANED", sessionId });
    }

    if (this.notifyUnhandledFailure) {
      this.notifyUnhandledFailure = false;
      void vscode.window.showErrorMessage(
        "Next Recording stopped because its journal could no longer be written. Durable data was kept for recovery.",
      );
    }
  }

  private completeStart(result: StartResult): void {
    const resolve = this.startResolver;
    this.startResolver = null;
    resolve?.(result);
  }

  private completeStop(result: StopResult): void {
    const resolve = this.stopResolver;
    this.stopResolver = null;
    this.stopPromise = null;
    resolve?.(result);
  }

  private isCurrentMachineSession(state: RecordingMachineState, sessionId: string): boolean {
    const snapshot = this.actor.getSnapshot();
    return snapshot.value === state && snapshot.context.sessionId === sessionId;
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error("recording coordinator was disposed");
    }
  }

  /** Test-only crash simulation: keep durable files but skip finalization. */
  async abandonForTest(): Promise<string | null> {
    const recording = this.active;
    if (!recording || this.stateValue !== "recording") {
      return null;
    }
    const dir = recording.paths.sessionDir;
    recording.session.stop();
    try {
      await recording.journal.abandonForTest();
    } finally {
      if (this.active === recording) {
        this.active = null;
      }
      if (this.isCurrentMachineSession("recording", recording.session.sessionId)) {
        this.actor.send({ type: "ABANDON", sessionId: recording.session.sessionId });
      }
    }
    return dir;
  }

  /** Best-effort shutdown; durable recovery handles the rest (plan §9.8). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.active) {
      try {
        this.active.session.stop();
      } catch {
        // Recovery owns any partially flushed session.
      }
      void this.active.journal.close().catch(() => {});
      this.active = null;
    }
    this.actorSubscription.unsubscribe();
    this.actor.stop();
    this.completeStart({
      ok: false,
      code: "failed",
      message: "recording coordinator was disposed",
    });
    this.completeStop({
      ok: false,
      code: "failed",
      message: "recording coordinator was disposed",
    });
    this.stateEmitter.dispose();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
