import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/model/events";
import { OrderedJournalWriter } from "../../src/storage/OrderedJournalWriter";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-writerfail-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeEvent(seq: number): SessionEvent {
  return { seq, tUs: seq, type: "marker", payload: { label: `e${seq}` } };
}

describe("journal writer failure (disk errors)", () => {
  it("surfaces write errors, stops accepting, and drain does not hang", async () => {
    const file = path.join(dir, "events.ndjson");
    const errors: Error[] = [];
    const writer = await OrderedJournalWriter.open(file, {
      flushIntervalMs: 5,
      onError: (error) => errors.push(error),
    });

    writer.enqueue(makeEvent(0));
    await writer.drain();
    expect(writer.lastDurableSeq).toBe(0);

    // Simulate the disk vanishing mid-session: close the handle behind the
    // writer's back so the next write fails like an I/O error would.
    await (writer as unknown as { handle: { close(): Promise<void> } }).handle.close();

    writer.enqueue(makeEvent(1));
    await writer.drain(); // must resolve, not hang
    expect(errors.length).toBeGreaterThan(0);
    expect(writer.error).not.toBeNull();

    // Later enqueues are ignored after failure; durable seq is unchanged.
    writer.enqueue(makeEvent(2));
    await writer.drain();
    expect(writer.lastDurableSeq).toBe(0);

    await writer.close().catch(() => {});
    // The durable prefix on disk remains readable.
    const content = await fs.readFile(file, "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });
});
