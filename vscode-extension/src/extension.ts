import * as vscode from "vscode";
import { RecordingCoordinator } from "./capture/RecordingCoordinator";
import { registerCommands } from "./commands/registerCommands";
import { registerDevCommands } from "./commands/devCommands";
import { RecordingEditorProvider } from "./playback/RecordingEditorProvider";
import { RecordingStatusBar } from "./ui/RecordingStatusBar";

let coordinator: RecordingCoordinator | undefined;

export function activate(context: vscode.ExtensionContext): void {
  coordinator = new RecordingCoordinator(context);
  context.subscriptions.push(coordinator);
  new RecordingStatusBar(coordinator, context);
  registerCommands(context, coordinator);
  registerDevCommands(context, coordinator);
  context.subscriptions.push(RecordingEditorProvider.register(context));
}

export function deactivate(): void {
  // Best-effort teardown; the durable journal plus activation-time recovery
  // guarantee no data loss on abrupt shutdown (plan §9.8).
  coordinator?.dispose();
  coordinator = undefined;
}
