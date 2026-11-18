// @vitest-environment node
// What chdir(2) checks, with the errors real Node v26 gives `process.chdir`
// (checked on the host: path is the working directory, dest the directory as
// given).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { setRuntime } from "../../runtime";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { checkChdir } from "./chdir";

let rt: FakeRuntime;

beforeEach(() => {
  rt = createFakeRuntime({ cwd: "/work" });
  rt.vfs.mkdir("/work/d/inner", true, 0o755);
  rt.vfs.writeFile("/work/file", new Uint8Array(0), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  setRuntime(rt);
});

afterEach(() => {
  setRuntime(null);
});

function refusal(directory: string): unknown {
  try {
    checkChdir(directory, directory.startsWith("/") ? directory : `/work/${directory}`);
  } catch (error) {
    const { code, errno, syscall, path, dest, message } = error as NodeJS.ErrnoException & {
      dest?: string;
    };
    return { code, errno, syscall, path, dest, message };
  }
  return "ok";
}

describe("checkChdir", () => {
  it("lets the process into a directory it may search", () => {
    expect(refusal("d")).toBe("ok");
    expect(refusal("/work/d/inner")).toBe("ok");
    // Search alone is enough.
    rt.vfs.chmod("/work/d", 0o100, true);
    expect(refusal("d")).toBe("ok");
  });

  it("refuses a directory it may not search, or one under such a directory", () => {
    rt.vfs.chmod("/work/d", 0o600, true);
    expect(refusal("d")).toEqual({
      code: "EACCES",
      errno: -13,
      syscall: "chdir",
      path: "/work",
      dest: "d",
      message: "EACCES: permission denied, chdir '/work' -> 'd'",
    });
    expect(refusal("d/inner")).toMatchObject({
      code: "EACCES",
      syscall: "chdir",
      message: "EACCES: permission denied, chdir '/work' -> 'd/inner'",
    });
    expect(refusal("/work/d/inner")).toMatchObject({
      message: "EACCES: permission denied, chdir '/work' -> '/work/d/inner'",
    });
  });

  it("says what chdir says for what is missing or not a directory", () => {
    expect(refusal("missing")).toMatchObject({
      code: "ENOENT",
      errno: -2,
      message: "ENOENT: no such file or directory, chdir '/work' -> 'missing'",
    });
    expect(refusal("file")).toMatchObject({
      code: "ENOTDIR",
      errno: -20,
      message: "ENOTDIR: not a directory, chdir '/work' -> 'file'",
    });
    expect(refusal("file/x")).toMatchObject({ code: "ENOTDIR", syscall: "chdir" });
  });
});
