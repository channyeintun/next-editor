import * as vscode from "vscode";
import { COMMANDS } from "../model/ids";

// Phase 1 placeholders. Real behavior arrives with the recording
// coordinator (Phase 5) and the recording library (Phase 6).
export function registerCommands(context: vscode.ExtensionContext): void {
  const notYet = (what: string) => () => {
    void vscode.window.showInformationMessage(`Next Recording: ${what} is not implemented yet.`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.start, notYet("start recording")),
    vscode.commands.registerCommand(COMMANDS.stop, notYet("stop recording")),
    vscode.commands.registerCommand(COMMANDS.recover, notYet("recovery")),
    vscode.commands.registerCommand(COMMANDS.open, notYet("the recording library")),
    vscode.commands.registerCommand(COMMANDS.export, notYet("export")),
  );
}
