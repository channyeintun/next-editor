// Pure formatting for the diagnostics channel (vscode-free so the privacy
// audit test can exercise it). Fields are primitives only by construction.
export type DiagnosticFields = Record<string, string | number | boolean | null>;

export function formatDiagnosticLine(
  level: "info" | "debug",
  code: string,
  fields: DiagnosticFields,
): string {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`);
  return `${new Date().toISOString()} [${level}] ${code}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
}
