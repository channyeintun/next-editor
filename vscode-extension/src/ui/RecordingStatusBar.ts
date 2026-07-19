import * as vscode from "vscode";
import type { CoordinatorState, RecordingCoordinator } from "../capture/RecordingCoordinator";
import { COMMANDS } from "../model/ids";

// Persistent, unambiguous recording indicator (plan §3.1, §14.1).
export class RecordingStatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recordingSinceMs: number | null = null;

  constructor(coordinator: RecordingCoordinator, context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      "nextRecording.status",
      vscode.StatusBarAlignment.Left,
      10_000,
    );
    this.item.name = "Next Recording";
    context.subscriptions.push(
      this.item,
      coordinator.onDidChangeState((state) => this.render(state)),
      { dispose: () => this.clearTimer() },
    );
    this.render(coordinator.state);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private render(state: CoordinatorState): void {
    this.clearTimer();
    switch (state) {
      case "idle":
        this.recordingSinceMs = null;
        this.item.hide();
        break;
      case "preparing":
        this.item.text = "$(record) Preparing…";
        this.item.backgroundColor = undefined;
        this.item.command = undefined;
        this.item.tooltip = "Next Recording: preparing";
        this.item.show();
        break;
      case "recording":
        this.recordingSinceMs = Date.now();
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        this.item.command = COMMANDS.stop;
        this.item.tooltip = "Next Recording: recording — click to stop";
        this.updateElapsed();
        this.timer = setInterval(() => this.updateElapsed(), 1000);
        this.item.show();
        break;
      case "stopping":
      case "finalizing":
        this.item.text = "$(sync~spin) Saving recording…";
        this.item.backgroundColor = undefined;
        this.item.command = undefined;
        this.item.tooltip = "Next Recording: finalizing";
        this.item.show();
        break;
    }
  }

  private updateElapsed(): void {
    const since = this.recordingSinceMs ?? Date.now();
    const totalSeconds = Math.floor((Date.now() - since) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    this.item.text = `$(record) REC ${minutes}:${String(seconds).padStart(2, "0")}`;
  }
}
