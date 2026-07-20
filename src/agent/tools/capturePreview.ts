import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext, ToolOutputContent } from "../types";
import { toRichToolModelOutput } from "./modelOutput";

export function makeCapturePreviewTool(ctx: ToolContext) {
  return tool({
    name: "capture_preview",
    description:
      "Capture the current visible WebContainer preview viewport as a PNG for visual inspection. " +
      "This is read-only and does not use screen-sharing permission.",
    inputSchema: z.object({}),
    execute: async (): Promise<string | ToolOutputContent[]> => {
      if (!ctx.capturePreviewScreenshot) {
        return "Preview screenshot capture is unavailable.";
      }

      if (ctx.signal.aborted) {
        return "Preview screenshot capture aborted.";
      }

      try {
        const screenshot = await ctx.capturePreviewScreenshot();
        if (ctx.signal.aborted) {
          return "Preview screenshot capture aborted.";
        }

        return [
          {
            type: "input_text",
            text:
              `Current preview screenshot (${screenshot.width}x${screenshot.height}). ` +
              "DOM-based rendering may omit cross-origin media or browser-native surfaces.",
          },
          { type: "input_image", imageUrl: screenshot.dataUrl, detail: "high" },
        ];
      } catch (error) {
        return `Unable to capture the preview: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    toModelOutput: ({ output }) => toRichToolModelOutput(output),
  });
}
