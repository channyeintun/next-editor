import * as vscode from "vscode";
import { CONFIG_NAMESPACE } from "../model/ids";
import { formatDiagnosticLine, type DiagnosticFields } from "./diagnosticsFormat";

export type DiagnosticLevel = "off" | "info" | "debug";
export type { DiagnosticFields } from "./diagnosticsFormat";

// Named output channel with a configurable level (plan §17.3).
// Allowed fields: IDs, counts, hashes, durations, sanitized labels, and
// error codes. Never source contents, replacement text, absolute source
// paths, environment variables, or credentials — the API accepts only
// primitive fields and is audited by test/unit/diagnostics.test.ts.
let channel: vscode.OutputChannel | null = null;

function currentLevel(): DiagnosticLevel {
  return (
    vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<DiagnosticLevel>("diagnostics.level") ??
    "off"
  );
}

export function logDiagnostic(
  level: Exclude<DiagnosticLevel, "off">,
  code: string,
  fields: DiagnosticFields = {},
): void {
  const configured = currentLevel();
  if (configured === "off" || (configured === "info" && level === "debug")) {
    return;
  }
  channel ??= vscode.window.createOutputChannel("Next Recording");
  channel.appendLine(formatDiagnosticLine(level, code, fields));
}

export function disposeDiagnostics(): void {
  channel?.dispose();
  channel = null;
}
