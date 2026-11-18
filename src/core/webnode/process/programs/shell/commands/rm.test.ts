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

  describe("a link to a directory", () => {
    const tree =
      "mkdir -p t/d/sub; echo f > t/d/f; echo s > t/d/sub/s; echo x > t/file; " +
      "ln -s d t/l; ln -s file t/lf; ";
    const left = "; echo $?; cd t && find . | sort";

    it("-r with a slash empties the directory behind it, then cannot remove the link's directory", async () => {
      const result = await sh(`${tree}rm -r t/l/${left}`);
      expect(result.err).toBe("rm: cannot remove 't/l/': Not a directory\n");
      expect(result.out).toBe("1\n.\n./d\n./file\n./l\n./lf\n");
    });

    it("-rf with a slash empties the directory behind it silently", async () => {
      const result = await sh(`${tree}rm -rf t/l/${left}`);
      expect(result.err).toBe("");
      expect(result.out).toBe("0\n.\n./d\n./file\n./l\n./lf\n");
    });

    it("without -r and with a slash is a directory, and nothing goes", async () => {
      const result = await sh(`${tree}rm t/l/${left}`);
      expect(result.err).toBe("rm: cannot remove 't/l/': Is a directory\n");
      expect(result.out).toBe("1\n.\n./d\n./d/f\n./d/sub\n./d/sub/s\n./file\n./l\n./lf\n");
    });

    it("-r without the slash removes only the link", async () => {
      const result = await sh(`${tree}rm -r t/l${left}`);
      expect(result.err).toBe("");
      expect(result.out).toBe("0\n.\n./d\n./d/f\n./d/sub\n./d/sub/s\n./file\n./lf\n");
    });

    it("-r on the directory itself, with a slash, removes it", async () => {
      const result = await sh(`${tree}rm -r t/d/${left}`);
      expect(result.err).toBe("");
      expect(result.out).toBe("0\n.\n./file\n./l\n./lf\n");
    });

    it("a link to a file with a slash is not a directory, which -f passes over", async () => {
      const plain = await sh(`${tree}rm t/lf/; echo $?; rm -r t/lf/${left}`);
      expect(plain.err).toBe(
        "rm: cannot remove 't/lf/': Not a directory\nrm: cannot remove 't/lf/': Not a directory\n",
      );
      expect(plain.out).toBe("1\n1\n.\n./d\n./d/f\n./d/sub\n./d/sub/s\n./file\n./l\n./lf\n");
      const forced = await sh(`${tree}rm -f t/lf/; echo $?; rm -rf t/lf/${left}`);
      expect(forced.err).toBe("");
      expect(forced.out).toBe("0\n0\n.\n./d\n./d/f\n./d/sub\n./d/sub/s\n./file\n./l\n./lf\n");
    });
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
  it("-v names every directory it makes, and none that was there", async () => {
    // GNU mkdir 9.5 prints the same lines.
    const result = await sh("mkdir -pv v/a v/a/b proj; mkdir -v w", { files });
    expect(result.out).toBe(
      "mkdir: created directory 'v'\n" +
        "mkdir: created directory 'v/a'\n" +
        "mkdir: created directory 'v/a/b'\n" +
        "mkdir: created directory 'w'\n",
    );
  });

  it("-p makes the directories a path goes through before a .. takes it back", async () => {
    const result = await sh("mkdir -p top/../second; ls", { files });
    expect(result.out).toBe("a.txt\nproj\nsecond\ntop\n");
  });

  it("-p fails on an existing file and accepts an existing directory", async () => {
    const result = await sh("touch f; mkdir -p f; echo $?; mkdir -p proj; echo $?", { files });
    expect(result.out).toBe("1\n0\n");
    expect(result.err).toBe("mkdir: cannot create directory 'f': File exists\n");
  });
});
