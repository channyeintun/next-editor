import type * as vscode from "vscode";
import type { UriSchemeClass } from "../model/events";
import { LIMITS } from "../model/limits";

// Schemes that are pure editor noise and must never be enrolled even when
// they appear in a visible editor (output panels, diff sides, etc. keep
// their own schemes).
const NOISE_SCHEMES = new Set([
  "output",
  "log",
  "debug",
  "search-editor",
  "comment",
  "interactive",
  "vscode",
  "vscode-settings",
  "vscode-scm",
  "walkThrough",
  "walkThroughSnippet",
]);

export function classifyScheme(uri: vscode.Uri): UriSchemeClass {
  switch (uri.scheme) {
    case "file":
      return "file";
    case "untitled":
      return "untitled";
    case "vscode-remote":
      return "remote";
    case "vscode-vfs":
    case "vscode-test-web":
    case "memfs":
      return "virtual";
    default:
      return "other";
  }
}

export type PolicyDecision =
  | { capture: true; schemeClass: UriSchemeClass }
  | { capture: false; schemeClass: UriSchemeClass; reason: "scheme" | "size" };

// Phase 2 defaults; the user-facing configuration surface (exclusion globs,
// includeUntitled, includeRemote) is wired in Phase 5/7 (plan §13.4, §18).
export function evaluateDocumentPolicy(document: vscode.TextDocument): PolicyDecision {
  const schemeClass = classifyScheme(document.uri);
  if (schemeClass === "other" || NOISE_SCHEMES.has(document.uri.scheme)) {
    return { capture: false, schemeClass, reason: "scheme" };
  }
  // Size pre-filter before reading full text (plan §8.3). UTF-8 length is
  // always >= UTF-16 code-unit count, so a document whose UTF-16 length
  // already exceeds the byte limit is certainly oversized. The exact UTF-8
  // check happens at enrollment.
  if (approximateDocumentUtf16Length(document) > LIMITS.maxCapturedDocumentBytes) {
    return { capture: false, schemeClass, reason: "size" };
  }
  return { capture: true, schemeClass };
}

function approximateDocumentUtf16Length(document: vscode.TextDocument): number {
  // offsetAt of the end position counts UTF-16 code units without
  // materializing the full string a second time.
  const lastLine = document.lineCount - 1;
  const end = document.lineAt(lastLine).range.end;
  return document.offsetAt(end);
}

export function exactSizeExceedsLimit(byteLength: number): boolean {
  return byteLength > LIMITS.maxCapturedDocumentBytes;
}
