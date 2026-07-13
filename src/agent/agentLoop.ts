import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import { createAnthropicClient } from "./anthropicClient";
import {
  DEFAULT_AGENT_MODEL,
  modelSupportsThinking,
  type AgentModelId,
  type Tool,
  type ToolConfirmationRequest,
  type ToolContext,
  type ToolExecuteResult,
} from "./types";
import { createToolMap, toAnthropicToolSchemas } from "./tools/index";
import { buildSystemPrompt } from "./systemPrompt";
import { getProject } from "./tools/workspaceFs";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { ChatDelta, ChatMessage } from "../types/chat";
import { toMessageParams } from "../types/chat";
import { createContentDelta } from "../core/src/utils/frameDelta";
import { getDmpCodec, isDmpCodecLoaded, loadDmpCodec } from "../storage/dmpCodec/dmpCodec";

// Default cap; Haiku 4.5's ceiling is 64K but every model here is well above this,
// and streaming means a large max_tokens never risks an HTTP timeout either way.
const MAX_TOKENS = 32000;
const MAX_ITERATIONS = 30;
// Coalesce streamed text into recorded/live deltas at ~10 Hz (plan §9.2) instead
// of one dmp delta per SSE chunk, so recording stays a few events per second.
const CONTENT_COALESCE_MS = 100;

// Adaptive thinking + effort are Sonnet/Opus-only (plan §5.2/§7): Haiku 4.5 errors
// on `effort` and supports neither, so these are omitted entirely for the default
// model and only sent when the user switches up for a harder task.
function reasoningParams(
  model: AgentModelId,
): Pick<Anthropic.MessageStreamParams, "thinking" | "output_config"> {
  if (!modelSupportsThinking(model)) {
    return {};
  }

  return {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  };
}

export interface RunAgentLoopOptions {
  apiKey: string;
  model?: AgentModelId;
  workspace: WorkspaceStoreInstance;
  tools: Tool[];
  /** Prior folded transcript to continue from; empty for a fresh conversation. */
  history: ChatMessage[];
  prompt: string;
  signal: AbortSignal;
  requestConfirmation: (request: ToolConfirmationRequest) => Promise<boolean>;
  onDelta: (delta: ChatDelta) => void;
  maxIterations?: number;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function summarizeToolContent(content: ToolExecuteResult["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[image: ${block.source.type === "base64" ? block.source.media_type : block.source.url}]`,
    )
    .join("\n");
}

/** Emits a whole-text insert in one delta — the prompt is already fully typed, not streamed. */
function emitFullTextMessage(
  onDelta: (delta: ChatDelta) => void,
  role: "user" | "assistant",
  text: string,
): void {
  const id = nextId("msg");
  onDelta({ k: "message_start", id, role });
  const delta = createContentDelta("", text);
  if (delta) {
    onDelta({ k: "content", delta });
  }
  onDelta({ k: "message_end", id });
}

async function runTool(
  block: Anthropic.ToolUseBlock,
  toolMap: Map<string, Tool>,
  toolContext: ToolContext,
  onDelta: (delta: ChatDelta) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = toolMap.get(block.name);

  if (!tool) {
    const content = `Unknown tool: ${block.name}`;
    onDelta({ k: "tool_result", toolUseId: block.id, content, isError: true });
    return { type: "tool_result", tool_use_id: block.id, content, is_error: true };
  }

  try {
    const result = await tool.execute(block.input, toolContext);
    onDelta({
      k: "tool_result",
      toolUseId: block.id,
      content: summarizeToolContent(result.content),
      isError: result.is_error,
    });
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: result.content,
      is_error: result.is_error,
    };
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error);
    onDelta({ k: "tool_result", toolUseId: block.id, content, isError: true });
    return { type: "tool_result", tool_use_id: block.id, content, is_error: true };
  }
}

/**
 * Runs one user turn to completion: streams the assistant's reply, executes any
 * tool calls, feeds results back, and repeats until the model stops asking for
 * tools (or `maxIterations` is hit). Emits a `ChatDelta` at every step (plan
 * §13) so a caller can drive both live UI (agentStore) and the recording track
 * (chatRecording.ts) off the same event stream.
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<void> {
  const {
    apiKey,
    model = DEFAULT_AGENT_MODEL,
    workspace,
    tools,
    history,
    prompt,
    signal,
    requestConfirmation,
    onDelta,
    maxIterations = MAX_ITERATIONS,
  } = options;

  if (!isDmpCodecLoaded()) {
    await loadDmpCodec();
  }
  getDmpCodec();

  const project = getProject(workspace);

  if (!project) {
    onDelta({ k: "status", status: "error" });
    throw new Error("No workspace loaded — the agent has no files to work with.");
  }

  const client = createAnthropicClient(apiKey);
  const toolMap = createToolMap(tools);
  const toolSchemas = toAnthropicToolSchemas(tools);

  // The confirm gate lives inside a tool's execute, but the loop owns the status
  // lifecycle — so wrap `requestConfirmation` here to surface `waiting-confirmation`
  // while any tool is blocked on the user, then fall back to `running-tool`. The
  // counter keeps the status correct when several gated tools run in one parallel
  // batch (status only leaves/returns on the first-in / last-out transitions).
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
  };
  const systemPrompt = buildSystemPrompt(project, {
    toolNames: tools.map((tool) => tool.name),
    hasBash: toolMap.has("bash"),
  });

  emitFullTextMessage(onDelta, "user", prompt);
  onDelta({ k: "status", status: "streaming" });

  let messages: Anthropic.MessageParam[] = [
    ...toMessageParams(history),
    { role: "user", content: prompt },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (signal.aborted) {
      onDelta({ k: "status", status: "done" });
      return;
    }

    const assistantMessageId = nextId("msg");
    onDelta({ k: "message_start", id: assistantMessageId, role: "assistant" });

    const stream = client.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: toolSchemas,
        messages,
        ...reasoningParams(model),
      },
      { signal },
    );

    let pendingText = "";
    let snapshotText = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // tool_use blocks that were streamed (folded into the transcript) this
    // iteration. On the happy path they each get a real tool_result below; on an
    // interrupt/error before that, they'd otherwise be left dangling — see the
    // catch handler.
    const streamedToolUseIds: string[] = [];

    const flush = () => {
      if (!pendingText) {
        return;
      }
      const nextText = snapshotText + pendingText;
      const contentDelta = createContentDelta(snapshotText, nextText);
      pendingText = "";
      snapshotText = nextText;
      if (contentDelta) {
        onDelta({ k: "content", delta: contentDelta });
      }
    };

    stream.on("text", (textDelta) => {
      pendingText += textDelta;
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        flush();
      }, CONTENT_COALESCE_MS);
    });

    stream.on("contentBlock", (block) => {
      if (block.type === "tool_use") {
        streamedToolUseIds.push(block.id);
        onDelta({ k: "tool_use", toolUseId: block.id, name: block.name, input: block.input });
      }
    });

    let finalMessage: Anthropic.Message;

    try {
      finalMessage = await stream.finalMessage();
    } catch (error) {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flush();
      onDelta({ k: "message_end", id: assistantMessageId });

      // The stream failed after one or more tool_use blocks were already streamed
      // and folded, but before their tools ran — so the transcript now holds a
      // tool_use with no matching tool_result. Left as-is, that history feeds the
      // *next* run and Anthropic rejects the request (every tool_use must be
      // answered). Close each unresolved tool_use with a synthetic error result so
      // the live transcript, the recording, and the continued conversation stay valid.
      for (const toolUseId of streamedToolUseIds) {
        onDelta({
          k: "tool_result",
          toolUseId,
          content: "Interrupted before this tool ran.",
          isError: true,
        });
      }

      if (error instanceof APIUserAbortError) {
        onDelta({ k: "status", status: "done" });
        return;
      }

      onDelta({ k: "status", status: "error" });
      throw error;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    flush();

    onDelta({
      k: "message_end",
      id: assistantMessageId,
      usage: {
        input: finalMessage.usage.input_tokens,
        output: finalMessage.usage.output_tokens,
      },
    });

    messages = [...messages, { role: "assistant", content: finalMessage.content }];

    if (finalMessage.stop_reason !== "tool_use") {
      onDelta({ k: "status", status: "done" });
      return;
    }

    onDelta({ k: "status", status: "running-tool" });

    const toolUseBlocks = finalMessage.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    const results = await Promise.all(
      toolUseBlocks.map((block) => runTool(block, toolMap, toolContext, onDelta)),
    );

    messages = [...messages, { role: "user", content: results }];
    onDelta({ k: "status", status: "streaming" });
  }

  onDelta({ k: "status", status: "done" });
}
