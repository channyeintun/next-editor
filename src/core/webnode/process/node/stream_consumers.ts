// The `stream/consumers` builtin: read a whole stream (a Node Readable, a web
// ReadableStream or any async iterable) into text, JSON, a Buffer, an
// ArrayBuffer, bytes or a Blob. Ported from Node 22's lib/stream/consumers.js.
import { Buffer } from "./buffer";

/** What the consumers accept. */
export type Consumable = AsyncIterable<unknown> | ReadableStream<unknown> | Iterable<unknown>;

async function* chunksOf(stream: Consumable): AsyncGenerator<unknown> {
  if (typeof ReadableStream !== "undefined" && stream instanceof ReadableStream) {
    // Not every browser makes ReadableStream async-iterable; read it directly.
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  yield* stream as AsyncIterable<unknown>;
}

/** The whole stream as a Blob. */
export async function blob(stream: Consumable): Promise<Blob> {
  const chunks: BlobPart[] = [];
  for await (const chunk of chunksOf(stream)) {
    chunks.push(chunk as BlobPart);
  }
  return new Blob(chunks);
}

/** The whole stream as an ArrayBuffer. */
export async function arrayBuffer(stream: Consumable): Promise<ArrayBuffer> {
  return (await blob(stream)).arrayBuffer();
}

/** The whole stream as a Buffer. */
export async function buffer(stream: Consumable): Promise<Buffer> {
  return Buffer.from(await arrayBuffer(stream));
}

/** The whole stream as a Uint8Array. */
export async function bytes(stream: Consumable): Promise<Uint8Array> {
  return new Uint8Array(await arrayBuffer(stream));
}

/** The whole stream decoded as UTF-8. */
export async function text(stream: Consumable): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of chunksOf(stream)) {
    if (typeof chunk === "string") {
      out += chunk;
    } else {
      out += decoder.decode(chunk as BufferSource, { stream: true });
    }
  }
  out += decoder.decode(undefined, { stream: false });
  return out;
}

/** The whole stream parsed as JSON. */
export async function json(stream: Consumable): Promise<unknown> {
  return JSON.parse(await text(stream));
}

/** What `require("stream/consumers")` returns. */
const streamConsumers = { arrayBuffer, blob, buffer, bytes, text, json };

export default streamConsumers;
