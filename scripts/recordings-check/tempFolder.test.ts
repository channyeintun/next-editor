// @vitest-environment node
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoppedBySignal, withTempFolder, type ProcessLike } from "./tempFolder.ts";

/** A process stand-in: signals are emitted by the test, and exit is recorded. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const host: ProcessLike = {
    on: (signal, listener) => emitter.on(signal, listener),
    off: (signal, listener) => emitter.off(signal, listener),
    exit: (code) => void exits.push(code),
  };
  return { host, emitter, exits };
}

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "recordings-check-test-"));
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const download = (folder: string) => writeFileSync(join(folder, "lesson.ne"), "bytes");

/**
 * A Ctrl-C pressed during a check: a signal reaches its listener only when the event
 * loop next turns, never in the middle of the check's own code.
 */
const pressCtrlCDuringCheck = (emitter: EventEmitter) => setImmediate(() => emitter.emit("SIGINT"));

describe("the temporary folder", () => {
  it("is removed with what was downloaded into it when the run ends", async () => {
    const { host, emitter } = fakeProcess();
    let seen = "";
    const result = await withTempFolder({ keep: false, parent, process: host }, async (folder) => {
      seen = folder;
      download(folder);
      expect(existsSync(join(folder, "lesson.ne"))).toBe(true);
      return "ran";
    });
    expect(result).toBe("ran");
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });

  it("is removed when the run throws, and the error still reaches the caller", async () => {
    const { host } = fakeProcess();
    let seen = "";
    await expect(
      withTempFolder({ keep: false, parent, process: host }, async (folder) => {
        seen = folder;
        download(folder);
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
    expect(existsSync(seen)).toBe(false);
  });

  it("is removed on Ctrl-C before the process exits", async () => {
    const { host, emitter, exits } = fakeProcess();
    let seen = "";
    await expect(
      withTempFolder({ keep: false, parent, process: host }, async (folder) => {
        seen = folder;
        download(folder);
        emitter.emit("SIGINT");
        expect(existsSync(folder)).toBe(false);
        expect(exits).toEqual([130]);
      }),
    ).rejects.toBeInstanceOf(StoppedBySignal);
    expect(existsSync(seen)).toBe(false);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });

  it("ends the run at the next stop point after a Ctrl-C held during a check", async () => {
    const { host, emitter, exits } = fakeProcess();
    const reached: string[] = [];
    let seen = "";
    await expect(
      withTempFolder({ keep: false, parent, process: host }, async (folder, stopPoint) => {
        seen = folder;
        download(folder);
        pressCtrlCDuringCheck(emitter);
        reached.push("first check");
        await stopPoint();
        reached.push("second check");
      }),
    ).rejects.toBeInstanceOf(StoppedBySignal);
    expect(reached).toEqual(["first check"]);
    expect(exits).toEqual([130]);
    expect(existsSync(seen)).toBe(false);
  });

  it("does not return as if it ran when a Ctrl-C was held during the last check", async () => {
    const { host, emitter, exits } = fakeProcess();
    const run = withTempFolder({ keep: false, parent, process: host }, async () => {
      pressCtrlCDuringCheck(emitter);
      return "printed the whole table";
    });
    await expect(run).rejects.toMatchObject({ exitCode: 130 });
    expect(exits).toEqual([130]);
  });

  it("is kept, and its path told, only when asked", async () => {
    const { host } = fakeProcess();
    const kept: string[] = [];
    let seen = "";
    await withTempFolder(
      { keep: true, parent, process: host, onKept: (path) => kept.push(path) },
      async (folder) => {
        seen = folder;
        download(folder);
      },
    );
    expect(kept).toEqual([seen]);
    expect(existsSync(join(seen, "lesson.ne"))).toBe(true);
  });

  it("is a new, empty folder of its own each run", async () => {
    const { host } = fakeProcess();
    const folders: string[] = [];
    for (let run = 0; run < 2; run++) {
      await withTempFolder({ keep: true, parent, process: host }, async (folder) => {
        expect(readdirSync(folder)).toEqual([]);
        folders.push(folder);
        download(folder);
      });
    }
    expect(new Set(folders).size).toBe(2);
  });
});
