import { describe, expect, it } from "vite-plus/test";
import { isJsonObject, readBodyWithLimit, readBytesWithLimit, readJsonWithLimit } from "./httpBody";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function message(body: ReadableStream<Uint8Array> | null, contentLength?: number) {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { body, headers };
}

describe("readBytesWithLimit", () => {
  it("returns the bytes of a body within the limit", async () => {
    const result = await readBytesWithLimit(
      message(streamOf(new Uint8Array([1, 2]), new Uint8Array([3]))),
      3,
    );
    expect(result).toEqual({ status: "ok", bytes: new Uint8Array([1, 2, 3]) });
  });

  it("refuses a declared length over the limit without reading", async () => {
    const result = await readBytesWithLimit(message(streamOf(new Uint8Array([1])), 4), 3);
    expect(result).toEqual({ status: "too-large" });
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    const result = await readBytesWithLimit(
      message(streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4]))),
      3,
    );
    expect(result).toEqual({ status: "too-large" });
  });

  it("reports a body stream that fails", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client went away"));
      },
    });
    expect(await readBytesWithLimit(message(failing), 3)).toEqual({ status: "read-error" });
  });

  it("reads a missing body as zero bytes", async () => {
    expect(await readBytesWithLimit(message(null), 3)).toEqual({
      status: "ok",
      bytes: new Uint8Array(0),
    });
  });
});

describe("readBodyWithLimit", () => {
  it("decodes the bytes as UTF-8", async () => {
    const result = await readBodyWithLimit(
      message(streamOf(new TextEncoder().encode("héllo"))),
      16,
    );
    expect(result).toEqual({ status: "ok", text: "héllo" });
  });
});

describe("readJsonWithLimit", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("parses a body within the limit", async () => {
    expect(await readJsonWithLimit(message(streamOf(encode('{"a":[1]}'))), 16)).toEqual({
      status: "ok",
      value: { a: [1] },
    });
  });

  it("refuses a declared length over the limit without reading", async () => {
    expect(await readJsonWithLimit(message(streamOf(encode("{}")), 17), 16)).toEqual({
      status: "too-large",
    });
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    expect(
      await readJsonWithLimit(message(streamOf(encode('{"a":'), encode('"long"}'))), 8),
    ).toEqual({ status: "too-large" });
  });

  it("reports a body stream that fails", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client went away"));
      },
    });
    expect(await readJsonWithLimit(message(failing), 16)).toEqual({ status: "read-error" });
  });

  it("reports a body that is not JSON, including a missing one", async () => {
    expect(await readJsonWithLimit(message(streamOf(encode("{nope"))), 16)).toEqual({
      status: "invalid-json",
    });
    expect(await readJsonWithLimit(message(null), 16)).toEqual({ status: "invalid-json" });
  });
});

describe("isJsonObject", () => {
  it("accepts objects and refuses null, arrays and primitives", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject("{}")).toBe(false);
    expect(isJsonObject(1)).toBe(false);
  });
});
