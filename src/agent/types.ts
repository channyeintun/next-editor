import type Anthropic from "@anthropic-ai/sdk";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";

export type AgentModelId = "claude-haiku-4-5" | "claude-sonnet-5" | "claude-opus-4-8";

export const DEFAULT_AGENT_MODEL: AgentModelId = "claude-haiku-4-5";

/** Only Sonnet/Opus support adaptive thinking + `output_config.effort`; sending either to Haiku errors. */
export function modelSupportsThinking(model: AgentModelId): boolean {
  return model !== "claude-haiku-4-5";
}

export interface ToolConfirmationRequest {
  toolName: string;
  /** Short human-readable description of what's about to happen, shown in the confirm prompt. */
  summary: string;
}

/**
 * Passed to every tool's `execute`. `workspace` is the same store instance the
 * editor renders from (see `stores/workspaceStore.ts`) — tool mutations flow
 * through its `store.trigger.*` events like any other write, which is also how
 * they land in the existing workspace recording track for free (plan §9.1).
 */
export interface ToolContext {
  workspace: WorkspaceStoreInstance;
  signal: AbortSignal;
  /** Resolves `true` to proceed. Only the `bash` tool requests it (confirm-gate, plan §11.3). */
  requestConfirmation: (request: ToolConfirmationRequest) => Promise<boolean>;
}

export type ToolResultContent =
  | string
  | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

export interface ToolExecuteResult {
  content: ToolResultContent;
  is_error?: boolean;
}

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  // Method shorthand (not a property typed as a function) so tools with different
  // concrete `TInput`s stay bivariantly assignable to `Tool<unknown>[]` in the
  // registry — the dispatcher passes parsed-JSON `unknown` input at that boundary
  // anyway, so per-tool input types only matter inside each tool's own file.
  execute(input: TInput, ctx: ToolContext): Promise<ToolExecuteResult>;
}

export type CredentialStorage = "memory" | "session" | "local";

export interface AgentCredential {
  apiKey: string;
  storage: CredentialStorage;
}
