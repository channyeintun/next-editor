import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { Tool, ToolExecuteResult } from "./types";
import type { ChatDelta } from "../types/chat";
import { runAgentLoop } from "./agentLoop";
import { createAnthropicClient } from "./anthropicClient";

vi.mock("./anthropicClient", () => ({
  createAnthropicClient: vi.fn<() => Anthropic>(),
}));

function createFakeWorkspaceStore(): WorkspaceStoreInstance {
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
    // Rest of the store surface is unused by the loop in this unit test — tool
    // behavior against a real store is covered by each tool's own tests.
  } as unknown as WorkspaceStoreInstance;
}

function makeUsage(): Anthropic.Usage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    server_tool_use: null,
  } as unknown as Anthropic.Usage;
}

function makeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: makeUsage(),
    ...overrides,
  } as Anthropic.Message;
}

type Listener = (...args: unknown[]) => void;

function createFakeStream(finalMessage: Anthropic.Message, finalError?: Error) {
  const listeners = new Map<string, Listener[]>();

  const fakeStream = {
    on(event: string, cb: Listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(cb);
      listeners.set(event, existing);
      return fakeStream;
    },
    finalMessage: async () => {
      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          for (const cb of listeners.get("contentBlock") ?? []) cb(block);
        }
      }
      if (finalError) throw finalError;
      return finalMessage;
    },
  };

  return fakeStream;
}

type FakeStream = ReturnType<typeof createFakeStream>;

function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

function baseOptions() {
  const deltas: ChatDelta[] = [];
  return {
    apiKey: "sk-ant-test",
    workspace: createFakeWorkspaceStore(),
    history: [],
    signal: new AbortController().signal,
    requestConfirmation: async () => true,
    onDelta: (delta: ChatDelta) => deltas.push(delta),
    deltas,
  };
}

describe("runAgentLoop", () => {
  it("finishes after a plain text turn with no tool calls", async () => {
    const streamFn = vi
      .fn<(body: { messages: Anthropic.MessageParam[] }) => FakeStream>()
      .mockReturnValue(
        createFakeStream(
          makeMessage({ content: [{ type: "text", text: "hi" } as Anthropic.TextBlock] }),
        ),
      );
    vi.mocked(createAnthropicClient).mockReturnValue({
      messages: { stream: streamFn },
    } as unknown as Anthropic);

    const { deltas, ...options } = baseOptions();
    await runAgentLoop({ ...options, tools: [], prompt: "hello", onDelta: (d) => deltas.push(d) });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(deltas.at(-1)).toEqual({ k: "status", status: "done" });
    expect(deltas.some((d) => d.k === "tool_use")).toBe(false);
    // Haiku (the default) must not receive thinking/effort — the API errors on them.
    const body = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("enables adaptive thinking + effort only when the model is switched up to Sonnet/Opus", async () => {
    const streamFn = vi
      .fn<(body: { messages: Anthropic.MessageParam[] }) => FakeStream>()
      .mockReturnValue(
        createFakeStream(
          makeMessage({ content: [{ type: "text", text: "ok" } as Anthropic.TextBlock] }),
        ),
      );
    vi.mocked(createAnthropicClient).mockReturnValue({
      messages: { stream: streamFn },
    } as unknown as Anthropic);

    const { deltas, ...options } = baseOptions();
    await runAgentLoop({
      ...options,
      model: "claude-sonnet-5",
      tools: [],
      prompt: "hard task",
      onDelta: (d) => deltas.push(d),
    });

    const body = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("collects every tool_result into a single follow-up user message and reports is_error", async () => {
    const okTool: Tool = {
      name: "ok",
      description: "ok",
      input_schema: { type: "object", properties: {} },
      execute: async (): Promise<ToolExecuteResult> => ({ content: "ok output" }),
    };
    const failingTool: Tool = {
      name: "failing",
      description: "failing",
      input_schema: { type: "object", properties: {} },
      execute: async (): Promise<ToolExecuteResult> => ({ content: "boom", is_error: true }),
    };

    const firstMessage = makeMessage({
      stop_reason: "tool_use",
      content: [toolUseBlock("call-1", "ok", {}), toolUseBlock("call-2", "failing", {})],
    });
    const secondMessage = makeMessage({
      content: [{ type: "text", text: "done" } as Anthropic.TextBlock],
    });

    const streamFn = vi
      .fn<(body: { messages: Anthropic.MessageParam[] }) => FakeStream>()
      .mockReturnValueOnce(createFakeStream(firstMessage))
      .mockReturnValueOnce(createFakeStream(secondMessage));
    vi.mocked(createAnthropicClient).mockReturnValue({
      messages: { stream: streamFn },
    } as unknown as Anthropic);

    const { deltas, ...options } = baseOptions();
    await runAgentLoop({
      ...options,
      tools: [okTool, failingTool],
      prompt: "do two things",
      onDelta: (d) => deltas.push(d),
    });

    expect(streamFn).toHaveBeenCalledTimes(2);
    const secondCallMessages = streamFn.mock.calls[1][0].messages as Anthropic.MessageParam[];
    const toolResultMessage = secondCallMessages.at(-1)!;
    expect(toolResultMessage.role).toBe("user");
    expect(toolResultMessage.content).toHaveLength(2);
    const resultBlocks = toolResultMessage.content as Anthropic.ToolResultBlockParam[];
    expect(resultBlocks.map((b) => b.tool_use_id)).toEqual(["call-1", "call-2"]);
    expect(resultBlocks[0].is_error).toBeUndefined();
    expect(resultBlocks[1].is_error).toBe(true);

    const toolResultDeltas = deltas.filter((d) => d.k === "tool_result");
    expect(toolResultDeltas).toHaveLength(2);
    expect(toolResultDeltas[1]).toMatchObject({ toolUseId: "call-2", isError: true });
  });

  it("emits waiting-confirmation while a gated tool is blocked, then restores running-tool", async () => {
    const gatedTool: Tool = {
      name: "gated",
      description: "gated",
      input_schema: { type: "object", properties: {} },
      execute: async (_input, ctx): Promise<ToolExecuteResult> => {
        const approved = await ctx.requestConfirmation({ toolName: "gated", summary: "do it" });
        return { content: approved ? "ran" : "declined", is_error: !approved };
      },
    };

    const firstMessage = makeMessage({
      stop_reason: "tool_use",
      content: [toolUseBlock("call-1", "gated", {})],
    });
    const secondMessage = makeMessage({
      content: [{ type: "text", text: "done" } as Anthropic.TextBlock],
    });
    const streamFn = vi
      .fn<(body: { messages: Anthropic.MessageParam[] }) => FakeStream>()
      .mockReturnValueOnce(createFakeStream(firstMessage))
      .mockReturnValueOnce(createFakeStream(secondMessage));
    vi.mocked(createAnthropicClient).mockReturnValue({
      messages: { stream: streamFn },
    } as unknown as Anthropic);

    const { deltas, ...options } = baseOptions();
    await runAgentLoop({
      ...options,
      tools: [gatedTool],
      prompt: "run the gated tool",
      requestConfirmation: async () => true,
      onDelta: (d) => deltas.push(d),
    });

    const statuses = deltas.filter((d) => d.k === "status").map((d) => d.status);
    // running-tool → waiting-confirmation (gate opens) → running-tool (gate closes)
    const waitingIndex = statuses.indexOf("waiting-confirmation");
    expect(waitingIndex).toBeGreaterThan(-1);
    expect(statuses[waitingIndex - 1]).toBe("running-tool");
    expect(statuses[waitingIndex + 1]).toBe("running-tool");
  });

  it("caps iterations when the model keeps requesting tools forever", async () => {
    const loopingTool: Tool = {
      name: "loop",
      description: "loop",
      input_schema: { type: "object", properties: {} },
      execute: async (): Promise<ToolExecuteResult> => ({ content: "again" }),
    };
    const foreverToolUse = () =>
      createFakeStream(
        makeMessage({ stop_reason: "tool_use", content: [toolUseBlock("call-x", "loop", {})] }),
      );

    const streamFn = vi
      .fn<(body: { messages: Anthropic.MessageParam[] }) => FakeStream>()
      .mockImplementation(foreverToolUse);
    vi.mocked(createAnthropicClient).mockReturnValue({
      messages: { stream: streamFn },
    } as unknown as Anthropic);

    const { deltas, ...options } = baseOptions();
    await runAgentLoop({
      ...options,
      tools: [loopingTool],
      prompt: "loop forever",
      maxIterations: 3,
      onDelta: (d) => deltas.push(d),
    });

    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(deltas.at(-1)).toEqual({ k: "status", status: "done" });
  });

  it("stops without error when the stream is aborted mid-turn", async () => {
    const controller = new AbortController();
    const abortError = new APIUserAbortError();
    const streamFn = vi
      .fn<(body: { messages: Anthropic.MessageParam[] }) => FakeStream>()
      .mockReturnValue(createFakeStream(makeMessage(), abortError));
    vi.mocked(createAnthropicClient).mockReturnValue({
      messages: { stream: streamFn },
    } as unknown as Anthropic);

    const { deltas, ...options } = baseOptions();
    await expect(
      runAgentLoop({
        ...options,
        signal: controller.signal,
        tools: [],
        prompt: "cancel me",
        onDelta: (d) => deltas.push(d),
      }),
    ).resolves.toBeUndefined();

    expect(deltas.filter((d) => d.k === "status").at(-1)).toEqual({ k: "status", status: "done" });
    expect(deltas.some((d) => d.k === "status" && d.status === "error")).toBe(false);
  });
});
