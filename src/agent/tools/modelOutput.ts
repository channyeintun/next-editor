import type { ToModelOutputResult } from "@openrouter/agent";
import type { ToolOutputContent } from "../types";

/** Preserve rich tool content when the OpenRouter SDK sends a result back to the model. */
export function toRichToolModelOutput(output: string | ToolOutputContent[]): ToModelOutputResult {
  return {
    type: "content",
    value: typeof output === "string" ? [{ type: "input_text", text: output }] : output,
  };
}
