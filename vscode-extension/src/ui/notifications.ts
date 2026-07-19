import * as vscode from "vscode";

const PRIVACY_ACK_KEY = "nextRecording.privacyDisclosureAcknowledged";

// One-time disclosure before the first recording (plan §13.4, §14.1).
export async function ensurePrivacyDisclosure(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(PRIVACY_ACK_KEY) === true) {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    "Next Recording stores the visible code of documents you open while recording " +
      "(and narration, once audio is supported) locally on this machine. Nothing is uploaded.",
    { modal: true },
    "Start Recording",
  );
  if (choice === "Start Recording") {
    await context.globalState.update(PRIVACY_ACK_KEY, true);
    return true;
  }
  return false;
}

export async function acknowledgePrivacyDisclosure(
  context: vscode.ExtensionContext,
): Promise<void> {
  await context.globalState.update(PRIVACY_ACK_KEY, true);
}

export function formatDuration(durationUs: number): string {
  const totalSeconds = Math.round(durationUs / 1_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
