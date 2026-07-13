import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";

const DEFAULT_HTML_LIMIT = 30_000;
const DOCUMENT_TEXT_LIMIT = 12_000;

const inputSchema = z.object({
  includeHtml: z.boolean().optional().describe("Include serialized live DOM; defaults to true"),
  maxHtmlChars: z
    .number()
    .int()
    .min(1_000)
    .max(50_000)
    .optional()
    .describe("Maximum serialized HTML characters; defaults to 30000"),
});

function extractDocumentText(html: string): string {
  try {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script, style, template").forEach((node) => node.remove());
    return (document.body?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DOCUMENT_TEXT_LIMIT);
  } catch {
    return "";
  }
}

export function makeInspectPreviewTool(ctx: ToolContext) {
  return tool({
    name: "inspect_preview",
    description:
      "Inspect the current rendered preview route, viewport, document text, and serialized live DOM " +
      "without running or restarting the dev server.",
    inputSchema,
    execute: (input): string => {
      const inspection = ctx.getPreviewInspection?.();
      if (!inspection) {
        return "The live preview has not produced a DOM snapshot yet. Check runtime_diagnostics first.";
      }

      const sections = [
        `Route: ${inspection.route}`,
        `URL: ${inspection.url ?? "not available"}`,
        `Viewport: ${inspection.width}x${inspection.height}`,
        `Captured: ${new Date(inspection.capturedAt).toISOString()}`,
        "Document text (may include visually hidden content):\n" +
          (extractDocumentText(inspection.html) || "(no document text)"),
      ];

      if (input.includeHtml !== false) {
        const maxChars = input.maxHtmlChars ?? DEFAULT_HTML_LIMIT;
        const truncated = inspection.html.length > maxChars;
        sections.push(
          `Rendered HTML${truncated ? ` (truncated after ${maxChars} characters)` : ""}:\n` +
            inspection.html.slice(0, maxChars),
        );
      }

      return sections.join("\n\n");
    },
  });
}
