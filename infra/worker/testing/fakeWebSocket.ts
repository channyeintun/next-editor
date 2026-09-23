import { serialize } from "node:v8";

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

/**
 * Durable Objects' serializeAttachment refuses a value whose V8 serialization
 * is larger than this, and node:v8's serialize is the same V8 ValueSerializer.
 * Measure under Node (vitest), not Bun: Bun's node:v8 shares repeated strings
 * and undercounts.
 */
const MAX_ATTACHMENT_BYTES = 16_384;

/** The parts of a hibernatable server WebSocket the Durable Objects use. */
export class FakeWebSocket {
  readyState = WEBSOCKET_OPEN;
  closeCode: number | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  private attachment: unknown = null;

  serializeAttachment(value: unknown): void {
    const size = serialize(value).byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`WebSocket attachment is ${size} bytes, over ${MAX_ATTACHMENT_BYTES}`);
    }
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  send(message: string | ArrayBuffer): void {
    this.sent.push(message);
  }

  close(code?: number): void {
    this.closeCode = code ?? null;
    this.readyState = WEBSOCKET_CLOSED;
  }

  /** The JSON text messages sent so far, parsed. */
  messages(): Array<Record<string, unknown>> {
    return this.sent.flatMap((message) =>
      typeof message === "string" ? [JSON.parse(message) as Record<string, unknown>] : [],
    );
  }
}
