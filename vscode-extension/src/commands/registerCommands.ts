import * as vscode from "vscode";
import type {
  RecordingCoordinator,
  StartResult,
  StopResult,
} from "../capture/RecordingCoordinator";
import { COMMANDS } from "../model/ids";
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
        void vscode.window.showInformationMessage(
          `Next Recording: saved ${result.eventCount} events over ${formatDuration(result.durationUs)}.`,
        );
      } else if (result.code === "failed") {
        void vscode.window.showErrorMessage(
          `Next Recording: finalization failed — ${result.message}. The working session is kept for recovery.`,
        );
      }
      return result;
    }),

    vscode.commands.registerCommand(COMMANDS.recover, notYet("recovery")),
    vscode.commands.registerCommand(COMMANDS.open, notYet("the recording library")),
    vscode.commands.registerCommand(COMMANDS.export, notYet("export")),
  );
}
