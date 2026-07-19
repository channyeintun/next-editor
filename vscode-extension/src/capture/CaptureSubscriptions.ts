import * as vscode from "vscode";
import type { CaptureSession } from "./CaptureSession";

// Installs every capture subscription (plan §2 research list). Callbacks
// only translate + enqueue; no filesystem awaits (plan §8.2).
export function installCaptureSubscriptions(session: CaptureSession): vscode.Disposable[] {
  return [
    vscode.workspace.onDidChangeTextDocument((event) => session.handleTextDocumentChange(event)),
    vscode.workspace.onDidOpenTextDocument((document) => session.handleOpenTextDocument(document)),
    vscode.workspace.onDidCloseTextDocument((document) =>
      session.handleCloseTextDocument(document),
    ),
    vscode.workspace.onDidSaveTextDocument((document) => session.handleSaveTextDocument(document)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => session.handleWorkspaceFoldersChanged()),
    vscode.window.onDidChangeVisibleTextEditors((editors) =>
      session.handleVisibleEditorsChanged(editors),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      session.handleActiveEditorChanged(editor),
    ),
    vscode.window.onDidChangeTextEditorSelection((event) => session.handleSelectionChanged(event)),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) =>
      session.handleVisibleRangesChanged(event),
    ),
    vscode.window.onDidChangeTextEditorViewColumn(() => session.scheduleTopology()),
    vscode.window.tabGroups.onDidChangeTabs(() => session.scheduleTopology()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => session.scheduleTopology()),
    vscode.window.onDidChangeWindowState((state) => session.handleWindowStateChanged(state)),
  ];
}
