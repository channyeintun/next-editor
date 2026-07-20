import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionEvent } from "../model/events";
import { LIMITS } from "../model/limits";

export type JournalWriterOptions = {
  flushIntervalMs?: number;
  flushBytes?: number;
  syncIntervalMs?: number;
  maxQueueBytes?: number;
  onOverload?: (queuedBytes: number) => void;
  onError?: (error: Error) => void;
};

type QueueEntry =
  | { kind: "line"; line: string; bytes: number; seq: number }
  | { kind: "barrier"; task: () => Promise<void> };

// Exactly one writer owns the journal file handle (plan §9.3). Callbacks
// enqueue synchronously; a single ordered pump performs writes; durability
// (lastDurableSeq) advances only after fdatasync.
export class OrderedJournalWriter {
  private queue: QueueEntry[] = [];
  private queuedBytes = 0;
  private pumping = false;
  private closed = false;
  private failed: Error | null = null;
  private overloadSignaled = false;
  private lastWrittenSeq = -1;
  private lastSyncedSeq = -1;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private terminalPromise: Promise<void> | null = null;

  private constructor(
    private readonly handle: fs.FileHandle,
    private readonly options: Required<Omit<JournalWriterOptions, "onOverload" | "onError">> &
      Pick<JournalWriterOptions, "onOverload" | "onError">,
  ) {
    this.flushTimer = setInterval(() => {
      void this.pump();
    }, this.options.flushIntervalMs);
    this.syncTimer = setInterval(() => {
      void this.syncNow();
    }, this.options.syncIntervalMs);
  }

  static async open(
    file: string,
    options: JournalWriterOptions = {},
  ): Promise<OrderedJournalWriter> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, "a");
    return new OrderedJournalWriter(handle, {
      flushIntervalMs: options.flushIntervalMs ?? LIMITS.journalFlushIntervalMs,
      flushBytes: options.flushBytes ?? LIMITS.journalFlushBytes,
      syncIntervalMs: options.syncIntervalMs ?? LIMITS.journalSyncIntervalMs,
      maxQueueBytes: options.maxQueueBytes ?? LIMITS.maxJournalQueueBytes,
      onOverload: options.onOverload,
      onError: options.onError,
    });
  }

  get lastDurableSeq(): number {
    return this.lastSyncedSeq;
  }

  get error(): Error | null {
    return this.failed;
  }

  private throwIfFailed(): void {
    if (this.failed) {
      throw this.failed;
    }
  }

  private notifyError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Observer failures must not replace the underlying storage error.
    }
  }

  private stopTimers(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** Synchronous, callback-safe. Never awaits filesystem work. */
  enqueue(event: SessionEvent): void {
    if (this.closed || this.failed) {
      return;
    }
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    this.queue.push({ kind: "line", line, bytes, seq: event.seq });
    this.queuedBytes += bytes;
    if (this.queuedBytes > this.options.maxQueueBytes && !this.overloadSignaled) {
      // Soft limit: never drop content events; signal so the capture layer
      // records an explicit overload marker (plan §8.8, §13.1).
      this.overloadSignaled = true;
      try {
        this.options.onOverload?.(this.queuedBytes);
      } catch {
        // Queue ownership and ordering cannot depend on an observer.
      }
    }
    if (this.queuedBytes >= this.options.flushBytes) {
      void this.pump();
    }
  }

  /**
   * Enqueue an ordered side effect (e.g. a checkpoint file write) that must
   * complete before any *later* enqueued event line reaches the journal
   * (plan §9.4: checkpoint body lands before its journaled reference).
   */
  enqueueBarrier(task: () => Promise<void>): void {
    if (this.closed || this.failed) {
      return;
    }
    this.queue.push({ kind: "barrier", task });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.failed || this.queue.length === 0) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];
        this.queuedBytes = 0;
        let lines: string[] = [];
        let lastSeq = this.lastWrittenSeq;
        const flushLines = async () => {
          if (lines.length > 0) {
            await this.handle.write(lines.join(""), null, "utf8");
            this.lastWrittenSeq = lastSeq;
            lines = [];
          }
        };
        for (const entry of batch) {
          if (entry.kind === "line") {
            lines.push(entry.line);
            lastSeq = entry.seq;
          } else {
            await flushLines();
            await entry.task();
          }
        }
        await flushLines();
      }
      if (this.overloadSignaled && this.queuedBytes < this.options.maxQueueBytes / 2) {
        this.overloadSignaled = false;
      }
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error));
      this.notifyError(this.failed);
    } finally {
      this.pumping = false;
    }
  }

  private async syncNow(): Promise<void> {
    // Serialize syncs; each captures the written seq before datasync.
    this.syncing = this.syncing.then(async () => {
      if (this.failed || this.lastWrittenSeq <= this.lastSyncedSeq) {
        return;
      }
      const target = this.lastWrittenSeq;
      try {
        await this.handle.datasync();
        this.lastSyncedSeq = target;
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error));
        this.notifyError(this.failed);
      }
    });
    await this.syncing;
  }

  /** Flush the queue and make everything written durable. */
  async drain(): Promise<void> {
    this.throwIfFailed();
    await this.pump();
    this.throwIfFailed();
    while (this.queue.length > 0 || this.pumping) {
      await this.pump();
      this.throwIfFailed();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.syncNow();
    this.throwIfFailed();
  }

  close(): Promise<void> {
    if (this.terminalPromise) {
      return this.terminalPromise;
    }
    this.closed = true;
    this.stopTimers();
    this.terminalPromise = Promise.resolve().then(async () => {
      try {
        await this.drain();
      } finally {
        await this.handle.close();
      }
    });
    return this.terminalPromise;
  }

  /** Test-only crash simulation: release resources without draining pending entries. */
  abandonForTest(): Promise<void> {
    if (this.terminalPromise) {
      return this.terminalPromise;
    }
    this.closed = true;
    this.stopTimers();
    this.queue = [];
    this.queuedBytes = 0;

    this.terminalPromise = Promise.resolve().then(async () => {
      // Let already-started filesystem calls finish before closing their handle,
      // but do not start another pump or durability sync.
      while (this.pumping) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await this.syncing.catch(() => {});
      await this.handle.close();
    });
    return this.terminalPromise;
  }
}
