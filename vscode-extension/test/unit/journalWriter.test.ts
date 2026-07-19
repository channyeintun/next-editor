import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/model/events";
import { readJournal } from "../../src/storage/JournalReader";
import { OrderedJournalWriter } from "../../src/storage/OrderedJournalWriter";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-journal-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeEvent(seq: number, tUs = seq * 1000): SessionEvent {
  return { seq, tUs, type: "marker", payload: { label: `event-${seq}` } };
}

describe("OrderedJournalWriter", () => {
  it("writes events in order and round-trips through the reader", async () => {
    const file = path.join(dir, "events.ndjson");
    const writer = await OrderedJournalWriter.open(file);
    for (let i = 0; i < 500; i++) {
      writer.enqueue(makeEvent(i));
    }
    await writer.close();

    const result = await readJournal(file);
    expect(result.corruption).toBeNull();
    expect(result.truncatedTailBytes).toBe(0);
    expect(result.events).toHaveLength(500);
    expect(result.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 500 }, (_, i) => i),
    );
  });

  it("advances lastDurableSeq only after drain", async () => {
    const file = path.join(dir, "events.ndjson");
    const writer = await OrderedJournalWriter.open(file, {
      flushIntervalMs: 10_000,
      syncIntervalMs: 10_000,
    });
    writer.enqueue(makeEvent(0));
    writer.enqueue(makeEvent(1));
    expect(writer.lastDurableSeq).toBe(-1);
    await writer.drain();
    expect(writer.lastDurableSeq).toBe(1);
    await writer.close();
  });

  it("signals overload once when the queue limit is crossed", async () => {
    const file = path.join(dir, "events.ndjson");
    let overloads = 0;
    const writer = await OrderedJournalWriter.open(file, {
      maxQueueBytes: 256,
      flushIntervalMs: 10_000,
      onOverload: () => {
        overloads += 1;
      },
    });
    // flushBytes default (64 KiB) is far above 256B so the queue accrues.
    for (let i = 0; i < 20; i++) {
      writer.enqueue(makeEvent(i));
    }
    expect(overloads).toBe(1);
    await writer.close();
    const result = await readJournal(file);
    expect(result.events).toHaveLength(20); // nothing dropped
  });

  it("barriers complete before later event lines are written", async () => {
    const file = path.join(dir, "events.ndjson");
    const sideFile = path.join(dir, "checkpoint.txt");
    const writer = await OrderedJournalWriter.open(file, {
      flushIntervalMs: 5,
    });
    let barrierRanAt = -1;
    writer.enqueue(makeEvent(0));
    writer.enqueueBarrier(async () => {
      // The barrier observes the journal as it exists mid-pipeline: only
      // event 0 may be on disk, never event 1.
      const content = await fs.readFile(file, "utf8").catch(() => "");
      barrierRanAt = content.split("\n").filter(Boolean).length;
      await fs.writeFile(sideFile, "checkpoint-body");
    });
    writer.enqueue(makeEvent(1));
    await writer.close();

    expect(barrierRanAt).toBeLessThanOrEqual(1);
    expect(await fs.readFile(sideFile, "utf8")).toBe("checkpoint-body");
    const result = await readJournal(file);
    expect(result.events.map((event) => event.seq)).toEqual([0, 1]);
  });

  it("byte offsets index every line", async () => {
    const file = path.join(dir, "events.ndjson");
    const writer = await OrderedJournalWriter.open(file);
    for (let i = 0; i < 10; i++) {
      writer.enqueue(makeEvent(i));
    }
    await writer.close();
    const raw = await fs.readFile(file, "utf8");
    const result = await readJournal(file);
    result.events.forEach((event, i) => {
      const offset = result.byteOffsets[i]!;
      const slice = Buffer.from(raw, "utf8").subarray(offset).toString("utf8");
      expect(JSON.parse(slice.slice(0, slice.indexOf("\n"))).seq).toBe(event.seq);
    });
  });
});
