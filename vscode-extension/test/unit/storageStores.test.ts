import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/capture/hash";
import type { CheckpointMeta } from "../../src/model/events";
import { CheckpointStore } from "../../src/storage/CheckpointStore";
import { SessionMetadataStore } from "../../src/storage/SessionMetadataStore";
import { SessionPaths } from "../../src/storage/SessionPaths";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-stores-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function meta(id: string, text: string): CheckpointMeta {
  return {
    checkpointId: id,
    documentId: "doc-1",
    reason: "interval",
    version: 3,
    eol: "LF",
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text),
  } as CheckpointMeta;
}

describe("CheckpointStore", () => {
  it("round-trips and verifies content", async () => {
    const store = new CheckpointStore(path.join(dir, "checkpoints"));
    const text = "hello 😀 world\nline two\n";
    await store.write(meta("cp-1", text), text);
    expect(await store.readVerified(meta("cp-1", text))).toBe(text);
    expect(await store.list()).toEqual(["cp-1"]);
  });

  it("rejects a write whose metadata hash does not match", async () => {
    const store = new CheckpointStore(path.join(dir, "checkpoints"));
    await expect(store.write(meta("cp-1", "other text"), "actual text")).rejects.toThrow(
      /hash mismatch/,
    );
  });

  it("detects corruption on verified read", async () => {
    const store = new CheckpointStore(path.join(dir, "checkpoints"));
    const text = "original";
    await store.write(meta("cp-1", text), text);
    await fs.writeFile(store.fileFor("cp-1"), "tampered");
    await expect(store.readVerified(meta("cp-1", text))).rejects.toThrow(/corrupted/);
  });

  it("rejects checkpoint ids with path separators", () => {
    const store = new CheckpointStore(path.join(dir, "checkpoints"));
    expect(() => store.fileFor("../escape")).toThrow(/invalid checkpoint id/);
  });
});

describe("SessionMetadataStore", () => {
  it("writes atomically and reads back the latest state", async () => {
    const paths = new SessionPaths(dir, "session-1");
    const store = SessionMetadataStore.createInitial(paths, {
      extensionVersion: "0.0.1",
      vscodeVersion: "1.129.0",
    });
    await store.update({ state: "recording" });
    await store.update({ state: "stopping", lastDurableSeq: 41 });

    const read = await SessionMetadataStore.read(paths);
    expect(read?.state).toBe("stopping");
    expect(read?.lastDurableSeq).toBe(41);
    expect(read?.sessionId).toBe("session-1");

    // No stray temp files left behind.
    const entries = await fs.readdir(paths.sessionDir);
    expect(entries).toEqual(["session.json"]);
  });

  it("an interrupted overwrite leaves the previous file intact", async () => {
    const paths = new SessionPaths(dir, "session-2");
    const store = SessionMetadataStore.createInitial(paths, {
      extensionVersion: "0.0.1",
      vscodeVersion: "1.129.0",
    });
    await store.update({ state: "recording" });
    // Simulate a crashed writer: a leftover temp file must not confuse reads.
    await fs.writeFile(path.join(paths.sessionDir, ".session.json.tmp-999"), "{garbage");
    const read = await SessionMetadataStore.read(paths);
    expect(read?.state).toBe("recording");
  });
});
