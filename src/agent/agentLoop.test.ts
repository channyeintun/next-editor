import { describe, expect, it, vi } from "vitest";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { ChatDelta } from "../types/chat";
import { runAgentLoop, type RunAgentLoopOptions } from "./agentLoop";

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
  } as unknown as WorkspaceStoreInstance;
}

// Minimal stand-ins for the SDK's streamed output items the loop reads.
type StreamItem = Record<string, unknown>;
const messageItem = (id: string, text: string): StreamItem => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const functionCallItem = (callId: string, name: string, args: string): StreamItem => ({
  type: "function_call",
  callId,
  name,
  arguments: args,
  status: "completed",
});
const functionOutputItem = (callId: string, output: string): StreamItem => ({
  type: "function_call_output",
  callId,
  output,
});

interface FakeModelInput {
  input: unknown;
  instructions?: unknown;
  model?: unknown;
}

function fakeCallModel(items: StreamItem[], usage?: { inputTokens: number; outputTokens: number }) {
  const calls: FakeModelInput[] = [];
  const cancel = vi.fn<() => Promise<void>>(async () => {});
  const callModel = ((request: FakeModelInput) => {
    calls.push(request);
    return {
      getItemsStream: async function* () {
        for (const item of items) {
          yield item;
        }
      },
      getResponse: async () => ({ usage }),
      cancel,
    };
  }) as unknown as NonNullable<RunAgentLoopOptions["callModel"]>;
  return { callModel, calls, cancel };
}

function baseOptions() {
  const deltas: ChatDelta[] = [];
  return {
    apiKey: "sk-or-test",
    workspace: createFakeWorkspaceStore(),
    history: [],
    signal: new AbortController().signal,
    requestConfirmation: async () => true,
    onDelta: (delta: ChatDelta) => deltas.push(delta),
    deltas,
  };
}

describe("runAgentLoop", () => {
  it("preserves structured details from a provider failure event", async () => {
    const { deltas, ...options } = baseOptions();
    const providerError = {
      code: "server_error",
      message: "Provider returned error",
      metadata: { raw: '{"error":{"message":"Model is overloaded"}}' },
    };
    const callModel = (() => ({
      getFullResponsesStream: async function* () {
        yield {
          type: "response.failed",
          response: { error: providerError },
        };
      },
      getItemsStream: async function* () {
        yield { type: "provider_failure_pending" };
        throw new Error("Response failed");
      },
      getResponse: async () => ({ usage: undefined }),
      cancel: async () => {},
    })) as unknown as NonNullable<RunAgentLoopOptions["callModel"]>;

    await expect(
      runAgentLoop({
        ...options,
        prompt: "hi",
        callModel,
        onDelta: (delta) => deltas.push(delta),
      }),
    ).rejects.toMatchObject({ providerError: { error: providerError } });
    expect(deltas.at(-1)).toEqual({ k: "status", status: "error" });
  });

  it("streams a plain text turn into message_start + content and ends done", async () => {
    const { deltas, ...options } = baseOptions();
    const { callModel } = fakeCallModel([messageItem("m1", "Hello there")]);

    await runAgentLoop({ ...options, prompt: "hi", callModel, onDelta: (d) => deltas.push(d) });

    expect(deltas.at(-1)).toEqual({ k: "status", status: "done" });
    // A user message and an assistant message were started.
    const starts = deltas.filter((d) => d.k === "message_start");
    expect(starts.map((d) => d.k === "message_start" && d.role)).toEqual(["user", "assistant"]);
    expect(deltas.some((d) => d.k === "tool_call")).toBe(false);
  });

  it("emits a tool_call and its matching tool_result for an executed tool", async () => {
    const { deltas, ...options } = baseOptions();
    const { callModel } = fakeCallModel([
      messageItem("m1", "reading"),
      functionCallItem("call-1", "read", '{"path":"index.html"}'),
      functionOutputItem("call-1", "<html></html>"),
    ]);

    await runAgentLoop({
      ...options,
      prompt: "read it",
      callModel,
      onDelta: (d) => deltas.push(d),
    });

    const toolCall = deltas.find((d) => d.k === "tool_call");
    expect(toolCall).toMatchObject({ callId: "call-1", name: "read" });
    const toolResult = deltas.find((d) => d.k === "tool_result");
    expect(toolResult).toMatchObject({ callId: "call-1", output: "<html></html>" });
  });

  it("closes a tool_call that never produced an output with a synthetic error result", async () => {
    const { deltas, ...options } = baseOptions();
    // A completed function_call but no matching function_call_output — the run
    // stopped between the call and its result.
    const { callModel } = fakeCallModel([
      messageItem("m1", "let me run that"),
      functionCallItem("call-x", "bash", '{"command":"ls"}'),
    ]);

    await runAgentLoop({ ...options, prompt: "run", callModel, onDelta: (d) => deltas.push(d) });

    const callIds = deltas
      .filter((d) => d.k === "tool_call")
      .map((d) => d.k === "tool_call" && d.callId);
    const answered = new Set(
      deltas.filter((d) => d.k === "tool_result").map((d) => d.k === "tool_result" && d.callId),
    );
    expect(callIds).toEqual(["call-x"]);
    expect(answered.has("call-x")).toBe(true);
    expect(deltas.some((d) => d.k === "tool_result" && d.callId === "call-x" && d.isError)).toBe(
      true,
    );
  });

  it("replays prior transcript items as history input ahead of the new user message", async () => {
    const { deltas, ...options } = baseOptions();
    const { callModel, calls } = fakeCallModel([messageItem("m1", "ok")]);

    await runAgentLoop({
      ...options,
      history: [{ kind: "message", id: "m0", role: "assistant", text: "earlier reply" }],
      prompt: "continue",
      callModel,
      onDelta: (d) => deltas.push(d),
    });

    const input = calls[0].input as Array<{ role?: string; content?: string }>;
    expect(input[0]).toEqual({ role: "assistant", content: "earlier reply" });
    expect(input.at(-1)).toEqual({ role: "user", content: "continue" });
  });

  it("sends pasted images as user input content", async () => {
    const { deltas, ...options } = baseOptions();
    const { callModel, calls } = fakeCallModel([messageItem("m1", "I can see it")]);
    const image = {
      id: "image-1",
      dataUrl: "data:image/png;base64,AA==",
      mimeType: "image/png",
    };

    await runAgentLoop({
      ...options,
      prompt: "What is wrong here?",
      images: [image],
      callModel,
      onDelta: (delta) => deltas.push(delta),
    });

    const input = calls[0].input as Array<{ role?: string; content?: unknown }>;
    expect(input.at(-1)?.content).toEqual([
      { type: "input_text", text: "What is wrong here?" },
      { type: "input_image", imageUrl: image.dataUrl, detail: "auto" },
    ]);
    expect(deltas).toContainEqual({
      k: "message_start",
      id: expect.any(String),
      role: "user",
      images: [image],
    });
  });

  it("reports token usage through onUsage", async () => {
    const { deltas, ...options } = baseOptions();
    const { callModel } = fakeCallModel([messageItem("m1", "done")], {
      inputTokens: 12,
      outputTokens: 7,
    });
    const onUsage = vi.fn<(usage: { inputTokens: number; outputTokens: number }) => void>();

    await runAgentLoop({
      ...options,
      prompt: "hi",
      callModel,
      onUsage,
      onDelta: (d) => deltas.push(d),
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 12, outputTokens: 7 });
  });

  it("ends with status done (no error) when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deltas, ...options } = baseOptions();
    const { callModel } = fakeCallModel([messageItem("m1", "unused")]);

    await runAgentLoop({
      ...options,
      signal: controller.signal,
      prompt: "cancel",
      callModel,
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas.filter((d) => d.k === "status").at(-1)).toEqual({ k: "status", status: "done" });
    expect(deltas.some((d) => d.k === "status" && d.status === "error")).toBe(false);
  });
});
