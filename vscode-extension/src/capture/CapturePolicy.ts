import * as vscode from "vscode";
import type { UriSchemeClass } from "../model/events";
import { CONFIG_NAMESPACE } from "../model/ids";
import { LIMITS } from "../model/limits";
import { globToRegExp } from "./glob";

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
  | {
      capture: false;
      schemeClass: UriSchemeClass;
      reason: "scheme" | "size" | "excluded" | "setting";
    };

export type CapturePolicyOptions = {
  excludeGlobs: string[];
  maxDocumentBytes: number;
  includeUntitled: boolean;
  includeRemote: boolean;
};

export const DEFAULT_POLICY_OPTIONS: CapturePolicyOptions = {
  excludeGlobs: [],
  maxDocumentBytes: LIMITS.maxCapturedDocumentBytes,
  includeUntitled: true,
  includeRemote: true,
};

export class CapturePolicy {
  readonly options: CapturePolicyOptions;
  private readonly excludePatterns: RegExp[];

  constructor(options: CapturePolicyOptions = DEFAULT_POLICY_OPTIONS) {
    const requestedMax = Number.isFinite(options.maxDocumentBytes)
      ? options.maxDocumentBytes
      : DEFAULT_POLICY_OPTIONS.maxDocumentBytes;
    this.options = {
      ...options,
      // A captured document must always fit in one artifact checkpoint.
      // Clamp programmatic/configuration values as well as declaring the
      // same maximum in package.json so a malformed setting cannot create
      // a recording that is impossible to finalize.
      maxDocumentBytes: Math.max(1024, Math.min(requestedMax, LIMITS.maxCheckpointBytes)),
    };
    this.excludePatterns = this.options.excludeGlobs.map(globToRegExp);
  }

  /** Snapshot of user configuration; frozen for the whole session (§18). */
  static fromConfiguration(): CapturePolicy {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return new CapturePolicy({
      excludeGlobs: config.get<string[]>("capture.exclude") ?? [],
      maxDocumentBytes:
        config.get<number>("capture.maxDocumentBytes") ?? LIMITS.maxCapturedDocumentBytes,
      includeUntitled: config.get<boolean>("capture.includeUntitled") ?? true,
      includeRemote: config.get<boolean>("capture.includeRemote") ?? true,
    });
  }

  evaluate(document: vscode.TextDocument): PolicyDecision {
    const schemeClass = classifyScheme(document.uri);
    if (schemeClass === "other" || NOISE_SCHEMES.has(document.uri.scheme)) {
      return { capture: false, schemeClass, reason: "scheme" };
    }
    if (schemeClass === "untitled" && !this.options.includeUntitled) {
      return { capture: false, schemeClass, reason: "setting" };
    }
    if ((schemeClass === "remote" || schemeClass === "virtual") && !this.options.includeRemote) {
      return { capture: false, schemeClass, reason: "setting" };
    }

    if (this.excludePatterns.length > 0) {
      const relative = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
      const baseName = relative.split("/").pop() ?? relative;
      for (const pattern of this.excludePatterns) {
        if (pattern.test(relative) || pattern.test(baseName)) {
          return { capture: false, schemeClass, reason: "excluded" };
        }
      }
    }

    // Size pre-filter before reading full text (plan §8.3). UTF-8 length is
    // always >= UTF-16 code-unit count, so a document whose UTF-16 length
    // already exceeds the byte limit is certainly oversized. The exact
    // UTF-8 check happens at enrollment.
    if (approximateDocumentUtf16Length(document) > this.options.maxDocumentBytes) {
      return { capture: false, schemeClass, reason: "size" };
    }
    return { capture: true, schemeClass };
  }

  exactSizeExceedsLimit(byteLength: number): boolean {
    return byteLength > this.options.maxDocumentBytes;
  }
}

function approximateDocumentUtf16Length(document: vscode.TextDocument): number {
  // offsetAt of the end position counts UTF-16 code units without
  // materializing the full string a second time.
  const lastLine = document.lineCount - 1;
  const end = document.lineAt(lastLine).range.end;
  return document.offsetAt(end);
}
