import * as vscode from "vscode";
import { RecordingCoordinator } from "./capture/RecordingCoordinator";
import { registerCommands } from "./commands/registerCommands";
import { registerDevCommands } from "./commands/devCommands";
import { announceRecoverableSessions, registerRecoverCommand } from "./commands/recoverCommand";
import { RecordingEditorProvider } from "./playback/RecordingEditorProvider";
import { disposeDiagnostics, logDiagnostic } from "./ui/diagnostics";
import { RecordingStatusBar } from "./ui/RecordingStatusBar";

let coordinator: RecordingCoordinator | undefined;

export function activate(context: vscode.ExtensionContext): void {
  coordinator = new RecordingCoordinator(context);
  context.subscriptions.push(coordinator);
  new RecordingStatusBar(coordinator, context);
  registerCommands(context, coordinator);
  registerRecoverCommand(context);
  // Diagnostic/test commands never ship in the installed product
  // (plan §15 Phase 9); EDH runs in Development/Test mode and keeps them.
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    registerDevCommands(context, coordinator);
  }
  context.subscriptions.push(RecordingEditorProvider.register(context));
  context.subscriptions.push(
    coordinator.onDidChangeState((state) => logDiagnostic("info", "recorder.state", { state })),
  );

  // Non-blocking activation-time recovery discovery (plan §9.8).
  void announceRecoverableSessions(context).catch((error) => {
    logDiagnostic("info", "recovery.scanFailed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export function deactivate(): void {
  // Best-effort teardown; the durable journal plus activation-time recovery
  // guarantee no data loss on abrupt shutdown (plan §9.8).
  coordinator?.dispose();
  coordinator = undefined;
  disposeDiagnostics();
}
