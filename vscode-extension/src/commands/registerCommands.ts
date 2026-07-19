import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  RecordingCoordinator,
  StartResult,
  StopResult,
} from "../capture/RecordingCoordinator";
import { COMMANDS, PLAYER_VIEW_TYPE } from "../model/ids";
import { RecordingLibrary } from "../storage/RecordingLibrary";
import { ensurePrivacyDisclosure, formatDuration } from "../ui/notifications";

export function registerCommands(
  context: vscode.ExtensionContext,
  coordinator: RecordingCoordinator,
): void {
  const notYet = (what: string) => () => {
    void vscode.window.showInformationMessage(`Next Recording: ${what} is not implemented yet.`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.start, async (): Promise<StartResult> => {
      if (coordinator.state !== "idle") {
        void vscode.window.showWarningMessage(
          "Next Recording: a recording is already in progress.",
        );
        return {
          ok: false,
          code: "already-active",
          message: `state is ${coordinator.state}`,
        };
      }
      const acknowledged = await ensurePrivacyDisclosure(context);
      if (!acknowledged) {
        return {
          ok: false,
          code: "failed",
          message: "privacy disclosure declined",
        };
      }
      const result = await coordinator.start();
      if (!result.ok) {
        void vscode.window.showErrorMessage(
          `Next Recording: could not start recording — ${result.message}`,
        );
      }
      return result;
    }),

    vscode.commands.registerCommand(COMMANDS.stop, async (): Promise<StopResult> => {
      const result = await coordinator.stop();
      if (result.ok) {
        void vscode.window
          .showInformationMessage(
            `Next Recording: saved ${result.eventCount} events over ${formatDuration(result.durationUs)}.`,
            "Open",
            "Export…",
          )
          .then(async (choice) => {
            if (choice === "Open") {
              await openRecordingInPlayer(result.artifactPath);
            } else if (choice === "Export…") {
              await vscode.commands.executeCommand(COMMANDS.export, result.artifactPath);
            }
          });
      } else if (result.code === "failed") {
        void vscode.window.showErrorMessage(
          `Next Recording: finalization failed — ${result.message}. The working session is kept for recovery.`,
        );
      }
      return result;
    }),

    vscode.commands.registerCommand(COMMANDS.recover, notYet("recovery")),

    // Recording library (plan §9.7): list and open local recordings.
    // Opening a recording never requires a workspace.
    vscode.commands.registerCommand(COMMANDS.open, async () => {
      const library = new RecordingLibrary(context.globalStorageUri.fsPath);
      const entries = await library.list();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage("Next Recording: no recordings yet.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.fileName,
          description: `${(entry.sizeBytes / 1024).toFixed(0)} KB — ${entry.modifiedAt.toLocaleString()}`,
          entry,
        })),
        { placeHolder: "Open a recording" },
      );
      if (picked) {
        await openRecordingInPlayer(picked.entry.filePath);
      }
    }),

    // Explicit export with a user-chosen destination (plan §9.7).
    vscode.commands.registerCommand(COMMANDS.export, async (artifactPath?: string) => {
      const library = new RecordingLibrary(context.globalStorageUri.fsPath);
      let sourcePath = artifactPath;
      if (!sourcePath) {
        const entries = await library.list();
        if (entries.length === 0) {
          void vscode.window.showInformationMessage("Next Recording: no recordings yet.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          entries.map((entry) => ({ label: entry.fileName, entry })),
          { placeHolder: "Export which recording?" },
        );
        if (!picked) {
          return;
        }
        sourcePath = picked.entry.filePath;
      }
      const defaultName = path.basename(sourcePath);
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
        filters: { "Next Recording": ["nextrecording"] },
      });
      if (!target) {
        return;
      }
      try {
        await exportArtifact(sourcePath, target);
        void vscode.window.showInformationMessage(
          `Next Recording: exported to ${target.fsPath || target.toString()}.`,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Next Recording: export failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}

async function openRecordingInPlayer(artifactPath: string): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(artifactPath),
    PLAYER_VIEW_TYPE,
  );
}

// Streamed local copy; bounded fallback with a warning for remote
// destinations (workspace.fs has no streaming API) — plan §9.7.
const MAX_REMOTE_EXPORT_BYTES = 256 * 1024 * 1024;

async function exportArtifact(sourcePath: string, target: vscode.Uri): Promise<void> {
  if (target.scheme === "file") {
    await fs.promises.copyFile(sourcePath, target.fsPath);
    return;
  }
  const stat = await fs.promises.stat(sourcePath);
  if (stat.size > MAX_REMOTE_EXPORT_BYTES) {
    throw new Error(
      `artifact is ${Math.round(stat.size / 1048576)} MB; exporting to a remote filesystem is limited to ${MAX_REMOTE_EXPORT_BYTES / 1048576} MB — export to a local path instead`,
    );
  }
  const proceed = await vscode.window.showWarningMessage(
    `Exporting ${Math.round(stat.size / 1048576)} MB to a remote filesystem may be slow. Continue?`,
    { modal: true },
    "Export",
  );
  if (proceed !== "Export") {
    return;
  }
  const data = await fs.promises.readFile(sourcePath);
  await vscode.workspace.fs.writeFile(target, data);
}
