import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/model/events";
import { readJournal } from "../../src/storage/JournalReader";
import { OrderedJournalWriter } from "../../src/storage/OrderedJournalWriter";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-recovery-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeEvent(seq: number): SessionEvent {
  return {
    seq,
    tUs: seq * 1000,
    type: "marker",
    payload: { label: `e${seq}` },
  };
}

async function writeJournal(file: string, count: number): Promise<void> {
  const writer = await OrderedJournalWriter.open(file);
  for (let i = 0; i < count; i++) {
    writer.enqueue(makeEvent(i));
  }
  await writer.close();
}

describe("journal crash recovery", () => {
  it("recovers the full prefix when truncated at any byte boundary", async () => {
    const original = path.join(dir, "events.ndjson");
    await writeJournal(original, 50);
    const bytes = await fs.readFile(original);

    // Newline positions let us compute the expected recovered count.
    const newlines: number[] = [];
    bytes.forEach((byte, index) => {
      if (byte === 0x0a) {
        newlines.push(index);
      }
    });

    // Sample truncation points across the file, including mid-line cuts.
    const cuts = new Set<number>([0, 1, bytes.length - 1, bytes.length]);
    for (let i = 1; i <= 40; i++) {
      cuts.add(Math.floor((bytes.length * i) / 41));
    }
    for (const cut of cuts) {
      const truncated = path.join(dir, `cut-${cut}.ndjson`);
      await fs.writeFile(truncated, bytes.subarray(0, cut));
      const result = await readJournal(truncated);
      const completeLines = newlines.filter((position) => position < cut).length;
      expect(result.corruption).toBeNull();
      // An unterminated final line that still parses as the next valid
      // event is legitimately recovered, hence the +1 tolerance.
      expect([completeLines, completeLines + 1]).toContain(result.events.length);
      result.events.forEach((event, index) => {
        expect(event.seq).toBe(index);
      });
    }
  });

  it("stops at a malformed line before the tail and reports corruption", async () => {
    const file = path.join(dir, "corrupt.ndjson");
    const lines = [
      JSON.stringify(makeEvent(0)),
      JSON.stringify(makeEvent(1)),
      "{ this is not json",
      JSON.stringify(makeEvent(3)),
    ];
    await fs.writeFile(file, `${lines.join("\n")}\n`);
    const result = await readJournal(file);
    expect(result.events).toHaveLength(2);
    expect(result.corruption).not.toBeNull();
    expect(result.corruption?.line).toBe(2);
  });

  it("discards a malformed final line as tail", async () => {
    const file = path.join(dir, "tail.ndjson");
    const lines = [JSON.stringify(makeEvent(0)), JSON.stringify(makeEvent(1))];
    await fs.writeFile(file, `${lines.join("\n")}\n{"seq":2,"tUs":`);
    const result = await readJournal(file);
    expect(result.events).toHaveLength(2);
    expect(result.corruption).toBeNull();
    expect(result.truncatedTailBytes).toBeGreaterThan(0);
  });

  it("detects sequence gaps", async () => {
    const file = path.join(dir, "gap.ndjson");
    const lines = [
      JSON.stringify(makeEvent(0)),
      JSON.stringify(makeEvent(2)),
      JSON.stringify(makeEvent(3)),
    ];
    await fs.writeFile(file, `${lines.join("\n")}\n`);
    const result = await readJournal(file);
    expect(result.events).toHaveLength(1);
    expect(result.corruption?.message).toContain("sequence gap");
  });

  it("detects decreasing timestamps", async () => {
    const file = path.join(dir, "time.ndjson");
    const e0: SessionEvent = {
      seq: 0,
      tUs: 5000,
      type: "marker",
      payload: { label: "a" },
    };
    const e1: SessionEvent = {
      seq: 1,
      tUs: 1000,
      type: "marker",
      payload: { label: "b" },
    };
    const e2: SessionEvent = {
      seq: 2,
      tUs: 6000,
      type: "marker",
      payload: { label: "c" },
    };
    await fs.writeFile(
      file,
      `${[JSON.stringify(e0), JSON.stringify(e1), JSON.stringify(e2)].join("\n")}\n`,
    );
    const result = await readJournal(file);
    expect(result.events).toHaveLength(1);
    expect(result.corruption?.message).toContain("decreasing timestamp");
  });
});
