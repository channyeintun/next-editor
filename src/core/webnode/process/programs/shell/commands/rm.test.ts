// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

const files = { "/work/proj/keep.txt": "k", "/work/a.txt": "a" };

describe("rm", () => {
  it("refuses . and .. whatever the flags, and goes on with the other operands", async () => {
    const up = await sh("cd proj && rm -rf ..; echo $?; ls /work/proj", { files });
    expect(up.out).toBe("1\nkeep.txt\n");
    expect(up.err).toBe("rm: refusing to remove '.' or '..' directory: skipping '..'\n");

    const here = await sh(
      "cd proj && rm -rf . ./ ../proj/. ../a.txt; echo $?; ls /work /work/proj",
      {
        files,
      },
    );
    expect(here.out).toBe("1\n/work:\nproj\n\n/work/proj:\nkeep.txt\n");
    expect(here.err).toBe(
      "rm: refusing to remove '.' or '..' directory: skipping '.'\n" +
        "rm: refusing to remove '.' or '..' directory: skipping './'\n" +
        "rm: refusing to remove '.' or '..' directory: skipping '../proj/.'\n",
    );
  });

  it("refuses / whatever the flags", async () => {
    const result = await sh("rm -f /; rm -rf //; echo $?; ls /work", { files });
    expect(result.out).toBe("1\na.txt\nproj\n");
  });

  it("refuses -i without -f instead of removing without asking", async () => {
    const asked = await sh("rm -i a.txt; echo $?; ls", { files });
    expect(asked.out).toBe("1\na.txt\nproj\n");
    expect(asked.err).toBe("rm: not removing 'a.txt': -i cannot ask for confirmation here\n");
    const forced = await sh("rm -if a.txt; echo $?; ls", { files });
    expect(forced.out).toBe("0\nproj\n");
  });
});

describe("mv", () => {
  it("refuses -i over an existing file, and moves when nothing would be overwritten", async () => {
    const result = await sh("echo b > b.txt; mv -i a.txt b.txt; echo $?; mv -i a.txt c.txt; ls", {
      files,
    });
    expect(result.out).toBe("1\nb.txt\nc.txt\nproj\n");
    expect(result.err).toBe("mv: not overwriting 'b.txt': -i cannot ask for confirmation here\n");
  });
});

describe("cp", () => {
  it("-p and -a keep times and modes", async () => {
    const result = await sh(
      "mkdir d; touch -d 2020-01-01T00:00:00Z a.txt d; chmod 600 a.txt; cp -p a.txt b.txt; cp -a d e; cp a.txt c.txt",
      { files },
    );
    const { vfs } = result;
    const source = vfs.stat("/work/a.txt", true);
    expect(vfs.stat("/work/b.txt", true).mtimeMs).toBe(source.mtimeMs);
    expect(vfs.stat("/work/b.txt", true).mode & 0o777).toBe(0o600);
    expect(vfs.stat("/work/e", true).mtimeMs).toBe(vfs.stat("/work/d", true).mtimeMs);
    expect(vfs.stat("/work/c.txt", true).mtimeMs).not.toBe(source.mtimeMs);
  });
});

describe("mkdir", () => {
  it("-p fails on an existing file and accepts an existing directory", async () => {
    const result = await sh("touch f; mkdir -p f; echo $?; mkdir -p proj; echo $?", { files });
    expect(result.out).toBe("1\n0\n");
    expect(result.err).toBe("mkdir: cannot create directory 'f': File exists\n");
  });
});
