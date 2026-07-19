import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CaptureSession } from "../capture/CaptureSession";
import { InMemoryEventSink } from "../capture/EventSink";
import type { RecordingCoordinator } from "../capture/RecordingCoordinator";
import { COMMAND_NAMESPACE } from "../model/ids";
import { PlaybackDataService } from "../playback/PlaybackDataService";
import { RecordingEditorProvider } from "../playback/RecordingEditorProvider";
import { RecoveryService } from "../storage/RecoveryService";
import { SessionPaths } from "../storage/SessionPaths";
import { acknowledgePrivacyDisclosure } from "../ui/notifications";

// Phase 2 diagnostic commands (not contributed to the palette): drive a
// capture spike session and inspect its trace. Removed before release
// (plan §15 Phase 9).
export type CaptureTrace = {
  sessionId: string;
  stopped: boolean;
  events: unknown[];
  checkpoints: {
    meta: unknown;
    textSha256Prefix: string;
    textLength: number;
  }[];
  checkpointTexts: Record<string, string>;
  counters: Record<string, number>;
  metrics: Record<string, unknown>;
};

let activeSpike: { session: CaptureSession; sink: InMemoryEventSink } | null = null;

function buildTrace(): CaptureTrace | null {
  if (!activeSpike) {
    return null;
  }
  const { session, sink } = activeSpike;
  const checkpointTexts: Record<string, string> = {};
  for (const [id, checkpoint] of sink.checkpoints) {
    checkpointTexts[id] = checkpoint.text;
  }
  return {
    sessionId: session.sessionId,
    stopped: session.isStopped,
    events: sink.events as unknown[],
    checkpoints: [...sink.checkpoints.values()].map(({ meta, text }) => ({
      meta,
      textSha256Prefix: meta.sha256.slice(0, 12),
      textLength: text.length,
    })),
    checkpointTexts,
    counters: session.countersSnapshot() as unknown as Record<string, number>,
    metrics: session.metrics.summary(),
  };
}

export function registerDevCommands(
  context: vscode.ExtensionContext,
  coordinator: RecordingCoordinator,
): void {
  const ns = `${COMMAND_NAMESPACE}.dev`;
  context.subscriptions.push(
    vscode.commands.registerCommand(`${ns}.captureStart`, () => {
      if (activeSpike && !activeSpike.session.isStopped) {
        return activeSpike.session.sessionId;
      }
      const sink = new InMemoryEventSink();
      const session = new CaptureSession(
        sink,
        String(context.extension.packageJSON.version ?? "0.0.0"),
      );
      activeSpike = { session, sink };
      session.start();
      return session.sessionId;
    }),

    vscode.commands.registerCommand(`${ns}.captureStop`, () => {
      if (!activeSpike) {
        return null;
      }
      activeSpike.session.stop();
      return activeSpike.session.countersSnapshot();
    }),

    vscode.commands.registerCommand(`${ns}.captureTrace`, () => buildTrace()),

    vscode.commands.registerCommand(`${ns}.dumpTrace`, async () => {
      const trace = buildTrace();
      if (!trace) {
        void vscode.window.showWarningMessage("Next Recording: no capture spike active.");
        return null;
      }
      const lines: string[] = [
        `session ${trace.sessionId} stopped=${trace.stopped}`,
        `counters ${JSON.stringify(trace.counters)}`,
        `metrics ${JSON.stringify(trace.metrics, null, 2)}`,
        "events:",
      ];
      for (const event of trace.events as {
        seq: number;
        tUs: number;
        type: string;
        payload: unknown;
      }[]) {
        lines.push(
          `  #${event.seq} t=${(event.tUs / 1000).toFixed(1)}ms ${event.type} ${JSON.stringify(event.payload).slice(0, 300)}`,
        );
      }
      const file = path.join(os.tmpdir(), `next-recording-trace-${Date.now()}.txt`);
      fs.writeFileSync(file, lines.join("\n"), "utf8");
      void vscode.window.showInformationMessage(`Next Recording: trace written to ${file}`);
      return file;
    }),

    vscode.commands.registerCommand(`${ns}.captureDiscard`, () => {
      if (activeSpike) {
        activeSpike.session.stop();
        activeSpike = null;
      }
    }),

    // ---- Phase 5+ test hooks (never contributed to the palette) --------

    vscode.commands.registerCommand(`${ns}.ackPrivacyDisclosure`, async () => {
      await acknowledgePrivacyDisclosure(context);
    }),

    vscode.commands.registerCommand(`${ns}.recorderState`, () => ({
      state: coordinator.state,
      sessionId: coordinator.activeSessionId,
      sessionDir: coordinator.activeSessionDir,
      lastError: coordinator.lastError,
    })),

    vscode.commands.registerCommand(`${ns}.simulateCrash`, () => coordinator.abandonForTest()),

    vscode.commands.registerCommand(`${ns}.recoveryScan`, async () => {
      const service = new RecoveryService(context.globalStorageUri.fsPath);
      const sessions = await service.scan();
      return sessions.map((session) => ({
        sessionId: session.sessionId,
        state: session.metadata?.state ?? null,
        recoverable: session.recoverable,
        sessionDir: session.paths.sessionDir,
      }));
    }),

    vscode.commands.registerCommand(`${ns}.recoveryInspect`, async (sessionId: string) => {
      const service = new RecoveryService(context.globalStorageUri.fsPath);
      const paths = new SessionPaths(context.globalStorageUri.fsPath, sessionId);
      const inspection = await service.inspect(paths);
      return {
        state: inspection.metadata?.state ?? null,
        eventCount: inspection.journal.events.length,
        truncatedTailBytes: inspection.journal.truncatedTailBytes,
        corruption: inspection.journal.corruption,
        lastEventType: inspection.lastEvent?.type ?? null,
      };
    }),

    vscode.commands.registerCommand(`${ns}.recoveryDiscard`, async (sessionId: string) => {
      const service = new RecoveryService(context.globalStorageUri.fsPath);
      await service.discard(new SessionPaths(context.globalStorageUri.fsPath, sessionId));
    }),

    vscode.commands.registerCommand(`${ns}.playerStatus`, () => ({
      webviewReadyCount: RecordingEditorProvider.webviewReadyCount,
    })),

    // Opens an artifact through the real reader stack and summarizes it
    // (integration-test hook for the host data plane).
    vscode.commands.registerCommand(`${ns}.readArtifact`, async (artifactPath: string) => {
      const service = await PlaybackDataService.open(
        artifactPath,
        artifactPath.split("/").pop() ?? artifactPath,
      );
      try {
        const metadata = service.metadata();
        const firstWindow = await service.eventWindow(0, 100);
        const firstDocument = metadata.documents[0];
        let checkpointLength: number | null = null;
        if (firstDocument) {
          for (const event of firstWindow.events) {
            if (
              event.type === "document.enrolled" &&
              event.payload.descriptor.documentId === firstDocument.documentId
            ) {
              const text = await service.checkpoint(
                firstDocument.documentId,
                event.payload.descriptor.initialCheckpointId,
              );
              checkpointLength = text.length;
              break;
            }
          }
        }
        return {
          eventCount: metadata.eventCount,
          durationUs: metadata.durationUs,
          documents: metadata.documents.map((doc) => doc.displayName),
          workspaceRoots: metadata.workspaceRoots.length,
          firstWindowSize: firstWindow.events.length,
          checkpointLength,
        };
      } finally {
        await service.dispose();
      }
    }),
  );
}
