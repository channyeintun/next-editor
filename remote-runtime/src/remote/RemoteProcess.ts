import type { WebContainerProcess } from "@webcontainer/api";
import { RcpConnection } from "./connection";

export class RemoteProcess implements WebContainerProcess {
  readonly exit: Promise<number>;
  readonly input: WritableStream<string>;
  readonly output: ReadableStream<string>;
  private resolveExit!: (code: number) => void;
  private unsubscribe: () => void;

  constructor(
    private readonly connection: RcpConnection,
    readonly pid: number,
    outChannel: number,
    inChannel: number,
  ) {
    this.exit = new Promise<number>((resolve) => { this.resolveExit = resolve; });
    const bytes = connection.channels.readable(outChannel);
    const decoder = new TextDecoder("utf-8");
    const reader = bytes.getReader();
    this.output = new ReadableStream<string>({
      pull: async (controller) => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) controller.enqueue(tail);
            controller.close();
            return;
          }
          const text = decoder.decode(value, { stream: true });
          if (text) { controller.enqueue(text); return; }
        }
      },
      cancel: () => reader.cancel(),
    });
    const writer = connection.channels.writable(inChannel).getWriter();
    const encoder = new TextEncoder();
    this.input = new WritableStream<string>({
      write: (chunk) => writer.write(encoder.encode(chunk)),
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
    this.unsubscribe = connection.on("proc.exit", (event) => {
      if (event.pid !== pid) return;
      this.unsubscribe();
      this.resolveExit(event.code);
    });
  }

  kill(): void {
    void this.connection.request("proc.kill", { pid: this.pid }).catch(() => {});
  }

  resize({ cols, rows }: { cols: number; rows: number }): void {
    void this.connection.request("proc.resize", { pid: this.pid, cols, rows }).catch(() => {});
  }
}
