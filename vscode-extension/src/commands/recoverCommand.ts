import * as vscode from "vscode";
import { COMMANDS, CONTEXT_KEYS } from "../model/ids";
import { RecoveryService } from "../storage/RecoveryService";
import { finalizeRecoveredSession } from "../storage/RecoveryFinalizer";
import { SessionPaths } from "../storage/SessionPaths";
import { logDiagnostic } from "../ui/diagnostics";

export async function refreshRecoveryContext(context: vscode.ExtensionContext): Promise<number> {
  const service = new RecoveryService(context.globalStorageUri.fsPath);
  const sessions = await service.scan();
  const recoverable = sessions.filter((session) => session.recoverable);
  await vscode.commands.executeCommand(
    "setContext",
    CONTEXT_KEYS.hasRecoverableSession,
    recoverable.length > 0,
  );
  return recoverable.length;
}

// Activation-time discovery (plan §9.8): offer recovery once, quietly.
export async function announceRecoverableSessions(context: vscode.ExtensionContext): Promise<void> {
  const count = await refreshRecoveryContext(context);
  if (count === 0) {
    return;
  }
  logDiagnostic("info", "recovery.found", { count });
  const choice = await vscode.window.showWarningMessage(
    count === 1
      ? "Next Recording: an interrupted recording was found."
      : `Next Recording: ${count} interrupted recordings were found.`,
    "Recover…",
    "Later",
  );
  if (choice === "Recover…") {
    await vscode.commands.executeCommand(COMMANDS.recover);
  }
}

export function registerRecoverCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.recover, async () => {
      const storageRoot = context.globalStorageUri.fsPath;
      const service = new RecoveryService(storageRoot);
      const sessions = (await service.scan()).filter((session) => session.recoverable);
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(
          "Next Recording: no interrupted recordings to recover.",
        );
        await refreshRecoveryContext(context);
        return;
      }

      const picked = await vscode.window.showQuickPick(
        sessions.map((session) => ({
          label: session.sessionId,
          description: `${session.metadata?.state ?? "no metadata"} — ${session.metadata?.updatedAt ?? "unknown time"}`,
          session,
        })),
        { placeHolder: "Interrupted recording to handle" },
      );
      if (!picked) {
        return;
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: "Finalize partial recording", action: "finalize" as const },
          { label: "Inspect failure details", action: "inspect" as const },
          { label: "Discard recording", action: "discard" as const },
          { label: "Defer", action: "defer" as const },
        ],
        { placeHolder: `Session ${picked.session.sessionId}` },
      );
      if (!action || action.action === "defer") {
        return;
      }

      switch (action.action) {
        case "finalize": {
          const result = await finalizeRecoveredSession(storageRoot, picked.session.sessionId);
          if (result.ok) {
            logDiagnostic("info", "recovery.finalized", {
              sessionId: picked.session.sessionId,
              recoveredEvents: result.recoveredEvents,
              droppedTailBytes: result.droppedTailBytes,
              alreadyFinalized: result.alreadyFinalized,
            });
            void vscode.window
              .showInformationMessage(
                result.alreadyFinalized
                  ? "Recording was already finalized."
                  : `Recovered ${result.recoveredEvents} events into a recording.`,
                "Open",
              )
              .then(async (choice) => {
                if (choice === "Open") {
                  await vscode.commands.executeCommand(
                    "vscode.openWith",
                    vscode.Uri.file(result.artifactPath),
                    "nextRecording.player",
                  );
                }
              });
          } else {
            void vscode.window.showErrorMessage(
              `Next Recording: recovery failed — ${result.message}. The working session is preserved.`,
            );
          }
          break;
        }
        case "inspect": {
          const inspection = await service.inspect(picked.session.paths);
          const lines = [
            `session:      ${picked.session.sessionId}`,
            `state:        ${inspection.metadata?.state ?? "unknown"}`,
            `updated:      ${inspection.metadata?.updatedAt ?? "unknown"}`,
            `failure:      ${inspection.metadata?.failure?.message ?? "none recorded"}`,
            `events:       ${inspection.journal.events.length}`,
            `tail dropped: ${inspection.journal.truncatedTailBytes} bytes`,
            `corruption:   ${inspection.journal.corruption ? `line ${inspection.journal.corruption.line}: ${inspection.journal.corruption.message}` : "none"}`,
            `last event:   ${inspection.lastEvent?.type ?? "n/a"}`,
          ];
          const doc = await vscode.workspace.openTextDocument({
            content: lines.join("\n"),
            language: "plaintext",
          });
          await vscode.window.showTextDocument(doc, { preview: true });
          break;
        }
        case "discard": {
          const confirmed = await vscode.window.showWarningMessage(
            `Discard the interrupted recording ${picked.session.sessionId}? This permanently deletes its working data.`,
            { modal: true },
            "Discard",
          );
          if (confirmed === "Discard") {
            await service.discard(new SessionPaths(storageRoot, picked.session.sessionId));
            logDiagnostic("info", "recovery.discarded", {
              sessionId: picked.session.sessionId,
            });
          }
          break;
        }
      }
      await refreshRecoveryContext(context);
    }),
  );
}
