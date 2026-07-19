import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { RecordingEditorProvider } from "./playback/RecordingEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  registerCommands(context);
  context.subscriptions.push(RecordingEditorProvider.register(context));
}

export function deactivate(): void {
  // Nothing yet: recording lifecycle cleanup arrives with the capture
  // coordinator (Phase 5), and working sessions are recoverable by design.
}
