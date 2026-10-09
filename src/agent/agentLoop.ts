import { stepCountIs } from "@openrouter/agent";
import type { FunctionCallOutputItem, Item, OpenRouter } from "@openrouter/agent";
import { createOpenRouterClient } from "./openrouterClient";
import {
  DEFAULT_AGENT_MODEL,
  type AgentModelId,
  type AgentObservers,
  type AgentUsage,
  type ToolConfirmationRequest,
  type ToolContext,
} from "./types";
import { codingToolNamesFor, createCodingTools } from "./tools/index";
import { buildSystemPrompt } from "./systemPrompt";
import { getProject } from "./tools/workspaceFs";
import { executionKindForLessonType } from "../types/lessonTypes";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { ChatDelta, ChatImage, ChatItem } from "../types/chat";
import { createAppendContentDelta, createContentDelta } from "../core/src/utils/contentDelta";
import { isDmpCodecLoaded, loadDmpCodec } from "../core/dmp/dmpCodec";
import { AgentProviderError } from "./agentError";
import { outputMessageText, toEasyInputMessage, toResponsesInput } from "./responsesInput";

const MAX_OUTPUT_TOKENS = 32000;
const MAX_STEPS = 30;

/** The one bound `callModel` method off an `OpenRouter` client — the only surface this loop needs. */
type CallModel = OpenRouter["callModel"];

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
  observers?: AgentObservers;
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
    ...options.observers,
    workspace,
    signal,
    requestConfirmation: gatedConfirmation,
  };
  // Playground lessons (Go, Kotlin, Rust, Zig, Haskell, Kite, assembly) have no
  // WebContainer runtime, so their agent runs with file tools only — no bash and
  // no runtime/preview observation.
  const executionKind = executionKindForLessonType(project.lessonType);
  const tools = createCodingTools(toolContext, executionKind);
  const systemPrompt = buildSystemPrompt(project, {
    toolNames: codingToolNamesFor(executionKind),
    hasBash: executionKind === "webcontainer",
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
    // Stop ends the SDK's tool loop at its next turn boundary and aborts the
    // in-flight request, so a stopped run stops calling the model on the
    // user's key.
    signal,
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
        const appendDelta = text.startsWith(messageSnapshot)
          ? createAppendContentDelta(messageSnapshot, text.slice(messageSnapshot.length))
          : null;
        const delta = appendDelta ?? createContentDelta(messageSnapshot, text);
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
    balanceUnansweredCalls();
    if (signal.aborted) {
      onDelta({ k: "status", status: "done" });
      return;
    }
    await providerErrorObserver;
    onDelta({ k: "status", status: "error" });
    throw providerError ? new AgentProviderError(error, providerError) : error;
  }

  // Aborted between items: settle now. `providerErrorObserver` drains the same
  // broadcaster the SDK's tool loop feeds, and the aborted loop only stops at its
  // next turn boundary, so awaiting it here could hold `isRunning` true — and the
  // panel wedged — until a tool still in flight returns. The `catch` branch
  // already returns early for exactly this reason; this is the same exit for the
  // non-throwing path. The observer's own IIFE swallows every error, so
  // abandoning it cannot reject.
  if (signal.aborted) {
    balanceUnansweredCalls();
    onDelta({ k: "status", status: "done" });
    return;
  }

  await providerErrorObserver;
  if (providerError) {
    balanceUnansweredCalls();
    onDelta({ k: "status", status: "error" });
    throw new AgentProviderError(new Error("Provider returned an error."), providerError);
  }
  balanceUnansweredCalls();

  if (onUsage) {
    // Totals across every model call the run made — each tool round, the SDK's
    // step-limit final turn, its empty-response retry. `getResponse()` reports
    // only the last turn, which in a tool-heavy run understates real spend by a
    // multiple. `getUsage()` never rejects.
    const usage = await result.getUsage();
    if (usage.modelCalls > 0) {
      onUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
  }

  onDelta({ k: "status", status: "done" });
}
