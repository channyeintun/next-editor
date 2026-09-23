const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

/** The parts of a hibernatable server WebSocket the Durable Objects use. */
export class FakeWebSocket {
  readyState = WEBSOCKET_OPEN;
  closeCode: number | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  private attachment: unknown = null;

  serializeAttachment(value: unknown): void {
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
