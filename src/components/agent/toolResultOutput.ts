/**
 * The agent SDK JSON-stringifies scalar tool return values before emitting a
 * `function_call_output`. Decode string results for display so code keeps its
 * real newlines and indentation instead of showing JSON escape sequences.
 */
export function formatToolResultOutput(output: string): string {
  const trimmed = output.trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed.trim() : trimmed;
  } catch {
    return trimmed;
  }
}
