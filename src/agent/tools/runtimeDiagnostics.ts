import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";

export function makeRuntimeDiagnosticsTool(ctx: ToolContext) {
  return tool({
    name: "runtime_diagnostics",
    description:
      "Read the existing WebContainer runtime status, recent dev-server output, runtime error, " +
      "and latest in-preview browser error. This is read-only and does not start a command.",
    inputSchema: z.object({}),
    execute: (): string => {
      const diagnostics = ctx.getRuntimeDiagnostics?.();
      if (!diagnostics) {
        return "Runtime diagnostics are unavailable.";
      }

      const previewMessage = diagnostics.latestPreviewMessage;
      const lifecycleEvent = diagnostics.latestLifecycleEvent;
      const sections = [
        `Status: ${diagnostics.status}`,
        `Supported: ${diagnostics.isSupported ? "yes" : "no"}`,
        `Preview: ${diagnostics.previewUrl ?? "not available"}`,
        `Preview port: ${diagnostics.previewPort ?? "not available"}`,
        `Active command: ${diagnostics.activeCommand ?? "none"}`,
        `Runtime error: ${diagnostics.errorMessage ?? "none"}`,
        previewMessage
          ? `Latest preview error: [${previewMessage.kind}]` +
            `${previewMessage.pathname ? ` ${previewMessage.pathname}` : ""} ` +
            previewMessage.text
          : "Latest preview error: none",
        lifecycleEvent
          ? `Latest lifecycle event: [${lifecycleEvent.kind}] ${lifecycleEvent.text}`
          : "Latest lifecycle event: none",
        `Recent dev-server output:\n${diagnostics.lastOutput?.trim() || "(no output captured)"}`,
      ];

      return sections.join("\n");
    },
  });
}
