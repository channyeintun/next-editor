import { describe, expect, it } from "vite-plus/test";
import type { ChatItem } from "../types/chat";
import { outputMessageText, toEasyInputMessage, toResponsesInput } from "./responsesInput";

const image = { id: "img-1", dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" };

describe("toEasyInputMessage", () => {
  it("sends plain text as a string when there are no images", () => {
    expect(toEasyInputMessage({ role: "user", text: "hello" })).toEqual({
      role: "user",
      content: "hello",
    });
    expect(toEasyInputMessage({ role: "user", text: "hello", images: [] })).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("sends text and images as content parts, text first", () => {
    expect(toEasyInputMessage({ role: "user", text: "what is this?", images: [image] })).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", imageUrl: image.dataUrl, detail: "auto" },
      ],
    });
  });

  it("omits the text part when an image is sent without text", () => {
    expect(toEasyInputMessage({ role: "user", text: "", images: [image] })).toEqual({
      role: "user",
      content: [{ type: "input_image", imageUrl: image.dataUrl, detail: "auto" }],
    });
  });
});

describe("toResponsesInput", () => {
  it("maps messages, tool calls and tool results to SDK items in order", () => {
    const items: ChatItem[] = [
      { kind: "message", id: "m1", role: "user", text: "fix it", images: [image] },
      { kind: "message", id: "m2", role: "assistant", text: "Reading the file." },
      {
        kind: "tool_call",
        id: "t1",
        callId: "call-1",
        name: "read_file",
        arguments: '{"path":"index.html"}',
      },
      { kind: "tool_result", id: "r1", callId: "call-1", output: "<html></html>", isError: true },
    ];

    expect(toResponsesInput(items)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "fix it" },
          { type: "input_image", imageUrl: image.dataUrl, detail: "auto" },
        ],
      },
      { role: "assistant", content: "Reading the file." },
      {
        type: "function_call",
        callId: "call-1",
        name: "read_file",
        arguments: '{"path":"index.html"}',
      },
      { type: "function_call_output", callId: "call-1", output: "<html></html>" },
    ]);
  });

  it("returns no items for an empty transcript", () => {
    expect(toResponsesInput([])).toEqual([]);
  });
});

describe("outputMessageText", () => {
  it("concatenates only the output_text parts", () => {
    expect(
      outputMessageText([
        { type: "output_text", text: "Hello, " },
        { type: "refusal", refusal: "no" },
        null,
        "stray",
        { type: "output_text", text: "world" },
      ]),
    ).toBe("Hello, world");
  });

  it("returns an empty string when no part is output_text", () => {
    expect(outputMessageText([])).toBe("");
    expect(outputMessageText([{ type: "refusal", refusal: "no" }])).toBe("");
  });
});
