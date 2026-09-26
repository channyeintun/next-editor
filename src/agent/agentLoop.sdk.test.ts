import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OpenRouter } from "@openrouter/agent";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { ChatDelta } from "../types/chat";
import { runAgentLoop, type AgentUsage } from "./agentLoop";

// Drives runAgentLoop through the real @openrouter/agent SDK — its tool loop,
// stream parsing, abort wiring and usage accounting — against a fake Responses
// API served from a stubbed `fetch`. agentLoop.test.ts covers the loop's own
// mapping through a hand-rolled result; this file pins the SDK contracts that
// mapping relies on, which a dependency bump can change underneath it.

function createWorkspace(): WorkspaceStoreInstance {
  return {
    getSnapshot: () => ({
      context: {
        isInitialized: true,
        project: {
          id: "p1",
          name: "Test project",
          lessonType: "html-css",
          entryFilePath: "index.html",
          folders: [],
          files: {
            "index.html": {
              path: "index.html",
              name: "index.html",
              language: "html",
              content: "<html></html>",
            },
          },
        },
      },
    }),
    trigger: {},
  } as unknown as WorkspaceStoreInstance;
}

function responseBody(n: number, status: string, output: unknown[], usage?: unknown) {
  return {
    id: `resp_${n}`,
    object: "response",
    created_at: 1,
    completed_at: status === "completed" ? 2 : null,
    error: null,
    frequency_penalty: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "test-model",
    output,
    parallel_tool_calls: true,
    presence_penalty: null,
    status,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    ...(usage ? { usage } : {}),
  };
}

function eventStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/**
 * Serves a model that calls `read` on each of its first `toolTurns` requests and
 * answers in text after that. Request `n` reports `100n` input tokens.
 */
function serveFakeModel(toolTurns: number): { requestCount: () => number } {
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests += 1;
    const n = requests;
    const item =
      n > toolTurns
        ? {
            type: "message",
            id: `msg_${n}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: `answer ${n}`, annotations: [] }],
          }
        : {
            type: "function_call",
            id: `fc_${n}`,
            call_id: `call_${n}`,
            name: "read",
            arguments: JSON.stringify({ path: "index.html" }),
            status: "completed",
          };
    const outputTokens = n > toolTurns ? 7 : 5;
    const events = [
      {
        type: "response.created",
        sequence_number: 0,
        response: responseBody(n, "in_progress", []),
      },
      { type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
      { type: "response.output_item.done", sequence_number: 2, output_index: 0, item },
      {
        type: "response.completed",
        sequence_number: 3,
        response: responseBody(n, "completed", [item], {
          input_tokens: 100 * n,
          output_tokens: outputTokens,
          total_tokens: 100 * n + outputTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        }),
      },
    ];
    return new Response(eventStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { requestCount: () => requests };
}

function baseOptions(signal: AbortSignal) {
  const client = new OpenRouter({ apiKey: "sk-or-test", serverURL: "https://example.test/api" });
  return {
    apiKey: "sk-or-test",
    workspace: createWorkspace(),
    history: [],
    prompt: "look at the page",
    signal,
    requestConfirmation: async () => true,
    callModel: client.callModel,
  };
}

describe("runAgentLoop over the real OpenRouter SDK", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the tool loop to a final answer and reports usage summed over every call", async () => {
    const model = serveFakeModel(2);
    const deltas: ChatDelta[] = [];
    const usages: AgentUsage[] = [];

    await runAgentLoop({
      ...baseOptions(new AbortController().signal),
      onDelta: (delta) => deltas.push(delta),
      onUsage: (usage) => usages.push(usage),
    });

    expect(model.requestCount()).toBe(3);
    expect(deltas.filter((delta) => delta.k === "tool_result")).toHaveLength(2);
    // (100 + 200 + 300) in, (5 + 5 + 7) out.
    expect(usages).toEqual([{ inputTokens: 600, outputTokens: 17 }]);
    expect(deltas.at(-1)).toEqual({ k: "status", status: "done" });
  });

  it("stops calling the model once the run is stopped", async () => {
    const model = serveFakeModel(Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    const deltas: ChatDelta[] = [];

    await runAgentLoop({
      ...baseOptions(controller.signal),
      maxSteps: 10,
      onDelta: (delta) => {
        deltas.push(delta);
        if (delta.k === "tool_result") controller.abort();
      },
    });
    // Leave an abandoned tool loop time to issue its next request.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(model.requestCount()).toBe(1);
    expect(deltas.at(-1)).toEqual({ k: "status", status: "done" });
    expect(deltas.some((delta) => delta.k === "status" && delta.status === "error")).toBe(false);
  });
});
