import { describe, expect, it } from "vitest";
import { readBodyWithLimit, readBytesWithLimit } from "./httpBody";

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
