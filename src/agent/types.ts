import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type {
  RuntimeLifecycleEvent,
  RuntimePreviewMessage,
} from "../contexts/WebContainerRuntimeContext";
import type { LivePreviewInspection } from "../stores/previewAdapterHandle";
import type { PreviewScreenshotResult } from "../utils/iframeScreenshotBridge";

/** OpenRouter model slug selected from its live model catalog. */
export type AgentModelId = string;

export const DEFAULT_AGENT_MODEL: AgentModelId = "anthropic/claude-haiku-4.5";

export interface ToolConfirmationRequest {
  toolName: string;
  /** Short human-readable description of what's about to happen, shown in the confirm prompt. */
  summary: string;
}

export interface AgentRuntimeDiagnostics {
  activeCommand: string | null;
  errorMessage: string | null;
  isSupported: boolean;
  lastOutput: string | null;
  latestLifecycleEvent: RuntimeLifecycleEvent | null;
  latestPreviewMessage: RuntimePreviewMessage | null;
  previewPort: number | null;
  previewUrl: string | null;
  status: string;
}

/**
 * Injected into each agent tool's `execute` via a closure (see `tools/index.ts`).
 * `workspace` is the same store instance the editor renders from
 * (`stores/workspaceStore.ts`) — tool mutations flow through its `store.trigger.*`
 * events like any other write, which is also how they land in the existing
 * workspace recording track for free.
 */
export interface ToolContext {
  workspace: WorkspaceStoreInstance;
  signal: AbortSignal;
  /** Resolves `true` to proceed. Only the `bash` tool requests it (confirm-gate). */
  requestConfirmation: (request: ToolConfirmationRequest) => Promise<boolean>;
  getRuntimeDiagnostics?: () => AgentRuntimeDiagnostics;
  getPreviewInspection?: () => Promise<LivePreviewInspection | null>;
  capturePreviewScreenshot?: () => Promise<PreviewScreenshotResult>;
}

/** Content-array output blocks a tool may return instead of a plain string (e.g. images). */
export type ToolOutputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; imageUrl: string; detail: "auto" | "low" | "high" };

export type CredentialStorage = "memory" | "session" | "local";

export interface AgentCredential {
  apiKey: string;
  storage: CredentialStorage;
}
