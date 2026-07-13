import { stepCountIs } from "@openrouter/agent";
import type { FunctionCallOutputItem, Item, OpenRouter } from "@openrouter/agent";
import { createOpenRouterClient } from "./openrouterClient";
import {
  DEFAULT_AGENT_MODEL,
  type AgentModelId,
  type ToolConfirmationRequest,
  type ToolContext,
} from "./types";
import { CODING_TOOL_NAMES, createCodingTools } from "./tools/index";
import { buildSystemPrompt } from "./systemPrompt";
import { getProject } from "./tools/workspaceFs";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { ChatDelta, ChatImage, ChatItem } from "../types/chat";
import { outputMessageText, toEasyInputMessage, toResponsesInput } from "../types/chat";
import { createContentDelta } from "../core/src/utils/frameDelta";
import { isDmpCodecLoaded, loadDmpCodec } from "../storage/dmpCodec/dmpCodec";
import { AgentProviderError } from "./agentError";

const MAX_OUTPUT_TOKENS = 32000;
const MAX_STEPS = 30;

/** The one bound `callModel` method off an `OpenRouter` client — the only surface this loop needs. */
type CallModel = OpenRouter["callModel"];

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunAgentLoopOptions {
  apiKey: string;
  model?: AgentModelId;
  workspace: WorkspaceStoreInstance;
  /** Prior folded transcript to continue from; empty for a fresh conversation. */
  history: ChatItem[];
  prompt: string;
  images?: ChatImage[];
  signal: AbortSignal;
  requestConfirmation: (request: ToolConfirmationRequest) => Promise<boolean>;
  getRuntimeDiagnostics?: ToolContext["getRuntimeDiagnostics"];
  getPreviewInspection?: ToolContext["getPreviewInspection"];
  capturePreviewScreenshot?: ToolContext["capturePreviewScreenshot"];
  onDelta: (delta: ChatDelta) => void;
  onUsage?: (usage: AgentUsage) => void;
  maxSteps?: number;
  /** Test seam: inject a fake `callModel` instead of constructing a real client. */
  callModel?: CallModel;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function extractOutput(output: FunctionCallOutputItem["output"]): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((part) => (part.type === "input_text" ? part.text : `[${part.type}]`))
      .join("\n");
  }
  return "";
}

/**
 * Runs one user turn to completion via the OpenRouter agent SDK: `callModel` owns
 * the tool loop (auto-executing our tools, whose `execute` closures still drive the
 * bash confirmation gate), and we map its single ordered `getItemsStream()` onto the
 * item-based `ChatDelta` stream so the same events feed both the live UI (agentStore)
 * and the recording track (chatRecording.ts).
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<void> {
  const {
    apiKey,
    model = DEFAULT_AGENT_MODEL,
    workspace,
    history,
    prompt,
    images = [],
    signal,
    requestConfirmation,
    onDelta,
    onUsage,
    maxSteps = MAX_STEPS,
  } = options;

  if (!isDmpCodecLoaded()) {
    await loadDmpCodec();
  }

  const project = getProject(workspace);

  if (!project) {
    onDelta({ k: "status", status: "error" });
    throw new Error("No workspace loaded — the agent has no files to work with.");
  }

  const callModel = options.callModel ?? createOpenRouterClient(apiKey).callModel;

  // Surface `waiting-confirmation` while any tool is blocked on the user, then fall
  // back to `running-tool`. The counter keeps the status correct when several gated
  // tools run in one parallel batch (only the first-in / last-out transition moves it).
  let pendingConfirmations = 0;
  const gatedConfirmation = async (request: ToolConfirmationRequest): Promise<boolean> => {
    pendingConfirmations += 1;
    if (pendingConfirmations === 1) {
      onDelta({ k: "status", status: "waiting-confirmation" });
    }
    try {
      return await requestConfirmation(request);
    } finally {
      pendingConfirmations -= 1;
      if (pendingConfirmations === 0 && !signal.aborted) {
        onDelta({ k: "status", status: "running-tool" });
      }
    }
  };

  const toolContext: ToolContext = {
    workspace,
    signal,
    requestConfirmation: gatedConfirmation,
    getRuntimeDiagnostics: options.getRuntimeDiagnostics,
    getPreviewInspection: options.getPreviewInspection,
    capturePreviewScreenshot: options.capturePreviewScreenshot,
  };
  const tools = createCodingTools(toolContext);
  const systemPrompt = buildSystemPrompt(project, {
    toolNames: CODING_TOOL_NAMES,
    hasBash: true,
  });

  // Emit the user's prompt as a whole message item (it's already fully typed).
  const userMessageId = nextId("msg");
  onDelta({
    k: "message_start",
    id: userMessageId,
    role: "user",
    ...(images.length ? { images } : {}),
  });
  const userDelta = createContentDelta("", prompt);
  if (userDelta) {
    onDelta({ k: "content", delta: userDelta });
  }
  onDelta({ k: "status", status: "streaming" });

  const userMessage = toEasyInputMessage({ role: "user", text: prompt, images });
  const input: Item[] = [...toResponsesInput(history), userMessage as Item];

  const result = callModel({
    model,
    instructions: systemPrompt,
    input,
    tools,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    stopWhen: stepCountIs(maxSteps),
  });

  // getItemsStream intentionally filters terminal API events. Observe the full
  // stream in parallel so a response.failed event's structured provider error is
  // still available if the SDK later throws only a generic message.
  let providerError: unknown = null;
  const providerErrorObserver =
    "getFullResponsesStream" in result && typeof result.getFullResponsesStream === "function"
      ? (async () => {
          try {
            for await (const event of result.getFullResponsesStream()) {
              if (event.type === "response.failed") {
                const failure = {
                  error: event.response.error,
                  openrouterMetadata: event.response.openrouterMetadata,
                };
                providerError = providerError ? [providerError, failure] : failure;
              } else if (event.type === "error") {
                providerError = providerError ? [providerError, event] : event;
              }
            }
          } catch (observerError) {
            // The item stream remains authoritative. Retain this only as extra
            // diagnostic context if it is the sole error the observer saw.
            providerError ??= observerError;
          }
        })()
      : Promise.resolve();

  const onAbort = () => {
    void result.cancel();
  };
  signal.addEventListener("abort", onAbort);

  // Adapter state: one active assistant message item at a time, plus the tool calls
  // seen this run (so a call is emitted once, and every emitted call is answered).
  let activeMessageId: string | null = null;
  let messageSnapshot = "";
  const pendingCalls = new Map<string, { name: string; args: string }>();
  const emittedCalls = new Set<string>();
  const answeredCalls = new Set<string>();

  /** Emit a `tool_call` delta once per callId. Returns true if it was newly emitted. */
  const emitToolCall = (callId: string): boolean => {
    if (emittedCalls.has(callId)) {
      return false;
    }
    const call = pendingCalls.get(callId);
    if (!call) {
      return false;
    }
    emittedCalls.add(callId);
    onDelta({ k: "tool_call", id: callId, callId, name: call.name, arguments: call.args });
    return true;
  };

  const answerCall = (callId: string, output: string, isError?: boolean): void => {
    if (answeredCalls.has(callId)) {
      return;
    }
    answeredCalls.add(callId);
    onDelta({ k: "tool_result", callId, output, isError });
  };

  // A `tool_call` that streamed but never got a result — the run stopped or was
  // interrupted between the call and its output — would leave the transcript (and
  // the history it feeds the next run) with an unanswered call, which the API
  // rejects. Close each one with a synthetic error result.
  const balanceUnansweredCalls = (): void => {
    for (const callId of pendingCalls.keys()) {
      emitToolCall(callId);
      answerCall(callId, "Interrupted before this tool ran.", true);
    }
  };

  try {
    for await (const item of result.getItemsStream()) {
      if (signal.aborted) {
        break;
      }

      if (item.type === "message") {
        if (item.id !== activeMessageId) {
          activeMessageId = item.id;
          messageSnapshot = "";
          onDelta({ k: "message_start", id: activeMessageId, role: "assistant" });
          onDelta({ k: "status", status: "streaming" });
        }
        const text = outputMessageText(item.content);
        const delta = createContentDelta(messageSnapshot, text);
        if (delta) {
          messageSnapshot = text;
          onDelta({ k: "content", delta });
        }
      } else if (item.type === "function_call") {
        pendingCalls.set(item.callId, { name: item.name, args: item.arguments });
        if (item.status === "completed" && emitToolCall(item.callId)) {
          onDelta({ k: "status", status: "running-tool" });
        }
      } else if (item.type === "function_call_output") {
        if (emitToolCall(item.callId)) {
          onDelta({ k: "status", status: "running-tool" });
        }
        answerCall(item.callId, extractOutput(item.output));
      }
    }
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    balanceUnansweredCalls();
    if (signal.aborted) {
      onDelta({ k: "status", status: "done" });
      return;
    }
    await providerErrorObserver;
    onDelta({ k: "status", status: "error" });
    throw providerError ? new AgentProviderError(error, providerError) : error;
  }

  signal.removeEventListener("abort", onAbort);
  await providerErrorObserver;
  if (providerError) {
    balanceUnansweredCalls();
    onDelta({ k: "status", status: "error" });
    throw new AgentProviderError(new Error("Provider returned an error."), providerError);
  }
  balanceUnansweredCalls();

  if (onUsage) {
    try {
      const response = await result.getResponse();
      const usage = response.usage as
        | { inputTokens?: number; outputTokens?: number }
        | null
        | undefined;
      if (usage) {
        onUsage({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
      }
    } catch {
      // Usage is best-effort — never fail a completed run over it.
    }
  }

  onDelta({ k: "status", status: "done" });
}
