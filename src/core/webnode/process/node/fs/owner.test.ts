// @vitest-environment node
// chown(2) as it answers a user who is not root, on the user's own files and
// on root's (/dev, which the kernel gives to root): the Linux answers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { GID, UID } from "../../platform";
import { setRuntime } from "../../runtime";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import type { Stats } from "./stats";
import { chownSync, closeSync, fchownSync, lchownSync, openSync, statSync } from "./sync";

let rt: FakeRuntime;

beforeEach(() => {
  rt = createFakeRuntime({ cwd: "/work" });
  rt.vfs.mkdir("/work", true, 0o755);
  rt.vfs.mkdir("/rootdir", true, 0o755);
  rt.vfs.privileged.giveToRoot("/rootdir");
  rt.vfs.writeFile("/work/mine", new Uint8Array(0), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  setRuntime(rt);
});

afterEach(() => {
  setRuntime(null);
});

function answer(run: () => void): string {
  try {
    run();
    return "ok";
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException;
    return `${code} ${syscall}`;
  }
}

describe("chown", () => {
  it("refuses every owner and group on a file root owns but -1, and allows the user's own on theirs", () => {
    const root = statSync("/rootdir") as Stats;
    expect([root.uid, root.gid]).toEqual([0, 0]);
    expect(answer(() => chownSync("/rootdir", 0, 0))).toBe("EPERM chown");
    expect(answer(() => chownSync("/rootdir", UID, GID))).toBe("EPERM chown");
    expect(answer(() => chownSync("/rootdir", -1, 0))).toBe("EPERM chown");
    expect(answer(() => lchownSync("/rootdir", 0, -1))).toBe("EPERM lchown");
    expect(answer(() => chownSync("/rootdir", -1, -1))).toBe("ok");
    const fd = openSync("/rootdir", "r");
    try {
      expect(answer(() => fchownSync(fd, 0, 0))).toBe("EPERM fchown");
    } finally {
      closeSync(fd);
    }
    expect(answer(() => chownSync("mine", UID, GID))).toBe("ok");
    expect(answer(() => chownSync("mine", 0, -1))).toBe("EPERM chown");
  });
});
