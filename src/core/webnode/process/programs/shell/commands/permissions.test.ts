// @vitest-environment node
// What the built-in commands say when the filesystem refuses them: GNU
// coreutils' words (checked against GNU rm, cp, mkdir, chmod, ls, mv, ln … run
// by a user who is not root), exit 1, and going on with the other operands.
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../../../runtime";
import { setRuntime } from "../../../runtime";
import { kernelShell, sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

const files = {
  "/work/ro/a": "a",
  "/work/ro/sub/b": "b",
  "/work/rw/c": "c",
  "/work/f": "f",
};

describe("rm", () => {
  it("removes what it can, names each refusal and passes over the directories above it", async () => {
    const result = await sh("chmod 555 ro; rm -rf ro rw; echo $?; ls -R ro; ls rw", { files });
    expect(result.err).toBe(
      "rm: cannot remove 'ro/a': Permission denied\n" +
        "rm: cannot remove 'ro/sub': Permission denied\n" +
        "ls: cannot access 'rw': No such file or directory\n",
    );
    expect(result.out).toBe("1\nro:\na\nsub\n\nro/sub:\n");
  });

  it("reports a refusal even with -f, and goes on with the other operands", async () => {
    const result = await sh("chmod 555 ro; rm -f ro/a ro/zz f; echo $?; ls", { files });
    expect(result.err).toBe("rm: cannot remove 'ro/a': Permission denied\n");
    expect(result.out).toBe("1\nro\nrw\n");
  });

  it("removes an empty directory it cannot read, and names one it could not empty", async () => {
    const result = await sh(
      "mkdir z nr nx; touch nr/q nx/q; chmod 0 z; chmod 311 nr; chmod 644 nx; " +
        "rm -r z; echo $?; rm -rf nr; echo $?; rm -rf nx; echo $?; ls",
      { files },
    );
    expect(result.err).toBe(
      "rm: cannot remove 'nr': Permission denied\nrm: cannot remove 'nx/q': Permission denied\n",
    );
    expect(result.out).toBe("0\n1\n1\nf\nnr\nnx\nro\nrw\n");
  });

  it("reports a file it may not look at even with -f, which passes over only a missing one", async () => {
    // GNU rm 9.5: the stat fails with EACCES, which -f does not ignore.
    const result = await sh(
      "mkdir nx; echo q > nx/q; chmod 644 nx; rm -f nx/q; echo $?; rm -f nx/none ro/none f/none; echo $?",
      { files },
    );
    expect(result.err).toBe(
      "rm: cannot remove 'nx/q': Permission denied\n" +
        "rm: cannot remove 'nx/none': Permission denied\n",
    );
    expect(result.out).toBe("1\n1\n");
  });

  it("empties a directory whose own directory refuses it, then says so", async () => {
    const result = await sh("chmod 555 /work; rm -r ro; echo $?; chmod 755 /work; ls -R ro", {
      files,
    });
    expect(result.err).toBe("rm: cannot remove 'ro': Permission denied\n");
    expect(result.out).toBe("1\nro:\n");
  });
});

describe("the other commands", () => {
  it("say Permission denied in GNU's words", async () => {
    const result = await sh(
      [
        "chmod 555 ro",
        "rmdir ro/sub",
        "mkdir ro/x ro/y",
        "mkdir -p ro/x/y",
        "touch ro/n",
        "cp f ro/",
        "mv ro/a ./a2",
        "ln -s f ro/l",
        "chmod 755 ro; chmod 0 ro/a",
        "cat ro/a",
        "head ro/a",
        "wc ro/a",
        "cp ro/a ./copied",
        "grep x ro/a f",
        "echo grep=$?",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "rmdir: failed to remove 'ro/sub': Permission denied",
        "mkdir: cannot create directory 'ro/x': Permission denied",
        "mkdir: cannot create directory 'ro/y': Permission denied",
        "mkdir: cannot create directory 'ro/x': Permission denied",
        "touch: cannot touch 'ro/n': Permission denied",
        "cp: cannot create regular file 'ro/f': Permission denied",
        "mv: cannot move 'ro/a' to './a2': Permission denied",
        "ln: failed to create symbolic link 'ro/l': Permission denied",
        "cat: ro/a: Permission denied",
        "head: cannot open 'ro/a' for reading: Permission denied",
        "wc: ro/a: Permission denied",
        "cp: cannot open 'ro/a' for reading: Permission denied",
        "grep: ro/a: Permission denied",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("grep=2\n");
  });

  it("ls ends its files with a blank line before directories it cannot open too", async () => {
    // GNU ls 9.5's standard output for the same operands, with ro at 311.
    const lines: [string, string][] = [
      ["ls ro f nope", "f\n\n"],
      ["ls f ro", "f\n\n"],
      ["ls -l f ro | cut -c1-10", "-rw-r--r--\n\n"],
      ["ls f ro rw", "f\n\nrw:\nc\n"],
      ["ls f rw ro", "f\n\nrw:\nc\n"],
      ["ls ro rw", "rw:\nc\n"],
      ["ls rw ro sub2", "rw:\nc\n\nsub2:\nd\n"],
      ["ls nope ro", ""],
      ["ls -R f ro", "f\n\n"],
    ];
    for (const [line, out] of lines) {
      const result = await sh(`chmod 311 ro; ${line}`, {
        files: { ...files, "/work/sub2/d": "d" },
      });
      expect(`${line} => ${result.out}`).toBe(`${line} => ${out}`);
      expect(result.err).toContain("ls: cannot open directory 'ro': Permission denied\n");
    }
  });

  it("cannot look into a directory it may not search", async () => {
    const result = await sh(
      "chmod 644 ro; ls ro; echo $?; ls -F ro; echo $?; chmod 600 ro/a; echo $?; " +
        "mv ro/a x; echo $?; ln ro/a hl; echo $?; cat ro/a; echo $?",
      { files },
    );
    expect(result.out).toBe("a\nsub\n0\na\nsub/\n1\n1\n1\n1\n1\n");
    expect(result.err).toBe(
      [
        "ls: cannot access 'ro/a': Permission denied",
        "chmod: cannot access 'ro/a': Permission denied",
        "mv: cannot stat 'ro/a': Permission denied",
        "ln: failed to access 'ro/a': Permission denied",
        "cat: ro/a: Permission denied",
        "",
      ].join("\n"),
    );
    const long = await sh("chmod 644 ro; ls -l ro; echo $?", { files });
    expect(long.err).toBe(
      "ls: cannot access 'ro/a': Permission denied\nls: cannot access 'ro/sub': Permission denied\n",
    );
    expect(long.out).toBe(
      "total 0\n-????????? ? ? ? ?            ? a\nd????????? ? ? ? ?            ? sub\n1\n",
    );
  });

  it("copies a tree past what it cannot read, and a read-only directory with its mode", async () => {
    const result = await sh(
      "mkdir -p src/nr; touch src/nr/c src/unread; echo a > src/a; chmod 0 src/unread; chmod 311 src/nr; " +
        "chmod 555 ro; cp -r src out; echo $?; ls out; cp -r ro rocopy; echo $?; ls -ld rocopy out/nr",
      { files },
    );
    expect(result.err).toBe(
      "cp: cannot access 'src/nr': Permission denied\n" +
        "cp: cannot open 'src/unread' for reading: Permission denied\n",
    );
    expect(result.out).toMatch(
      /^1\na\nnr\n0\nd-wx--x--x \d+ user user \d+ .* out\/nr\ndr-xr-xr-x \d+ user user \d+ .* rocopy\n$/,
    );
  });

  it("makes parents writable with mkdir -p -m, and sets -m exactly", async () => {
    const result = await sh(
      "mkdir -p -m 555 m/a/b; echo $?; mkdir -m 777 m7; ls -ld m m/a m/a/b m7",
      {
        files,
      },
    );
    expect(result.out).toMatch(
      /^0\ndrwxr-xr-x .* m\ndrwxr-xr-x .* m\/a\ndr-xr-xr-x .* m\/a\/b\ndrwxrwxrwx .* m7\n$/,
    );
  });

  it("shows setuid, setgid and sticky bits as GNU ls does (s/S, t/T)", async () => {
    // GNU ls 9.5 on the same modes: rwsr-xr-x, rwSr--r--, rwxr-sr-x,
    // rwxr-Sr-x, rwxr-xr-t, rwxr-xr-T, rwsrwsrwx, --S--S--T, rwSrwSrwT.
    const modes = ["4755", "4644", "2755", "2745", "1755", "1754", "6777", "7000", "7666"];
    const result = await sh(
      modes.map((mode) => `mkdir d${mode}; chmod ${mode} d${mode}`).join("; ") +
        "; chmod u+s,g+s,+t f; ls -ld " +
        modes.map((mode) => `d${mode}`).join(" ") +
        " f | cut -c1-10",
      { files },
    );
    expect(result.err).toBe("");
    expect(result.out).toBe(
      [
        "drwxr-xr-T",
        "drwxr-xr-t",
        "drwxr-Sr-x",
        "drwxr-sr-x",
        "drwSr--r--",
        "drwsr-xr-x",
        "drwsrwsrwx",
        "d--S--S--T",
        "drwSrwSrwT",
        "-rwSr-Sr-T",
        "",
      ].join("\n"),
    );
    const tmp = kernelShell(["sh", "-c", "ls -ld /tmp | cut -c1-10"]);
    await tmp.done;
    expect(tmp.output()).toBe("drwxrwxrwt\n");
  });

  it("names root as the owner of /dev and its devices, and the user for the rest", async () => {
    const shell = kernelShell(["sh", "-c", "ls -ld /dev /dev/null /tmp | cut -d' ' -f1,3,4"]);
    await shell.done;
    expect(shell.output()).toBe(
      ["drwxr-xr-x root root", "crw-rw-rw- root root", "drwxrwxrwt user user", ""].join("\n"),
    );
  });

  it("changes a whole tree's modes, reporting a directory it cannot read", async () => {
    const result = await sh(
      "mkdir -p t/nr; touch t/nr/q; chmod 311 t/nr; chmod -R 700 t; echo $?; " +
        "chmod 311 t/nr; chmod -R a-r t/nr; echo $?",
      { files },
    );
    expect(result.err).toBe("chmod: cannot read directory 't/nr': Permission denied\n");
    expect(result.out).toBe("0\n1\n");
  });
});

describe("the words of a refusal", () => {
  // Each expectation is GNU coreutils 9.5's output for the same commands.
  it("mkdir -p names the directory that stopped it, with that directory's reason", async () => {
    const result = await sh(
      [
        "mkdir nx; chmod 644 nx; chmod 555 ro",
        "mkdir -p nx/a/b",
        "mkdir -p f/x",
        "mkdir -p ro/a/x",
        "mkdir -p ro/m/n",
        "mkdir -p ro/new",
        "mkdir -p nx/../other/x",
        "mkdir -p rw/c/d",
        "mkdir nx/a",
        "echo $?",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "mkdir: cannot create directory 'nx': Permission denied",
        "mkdir: cannot create directory 'f': Not a directory",
        "mkdir: cannot create directory 'ro/a': Not a directory",
        "mkdir: cannot create directory 'ro/m': Permission denied",
        "mkdir: cannot create directory 'ro/new': Permission denied",
        "mkdir: cannot create directory 'nx': Permission denied",
        "mkdir: cannot create directory 'rw/c': Not a directory",
        "mkdir: cannot create directory 'nx/a': Permission denied",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("1\n");
  });

  it("ln names both ends of a hard link it could not make", async () => {
    const result = await sh(
      [
        "chmod 555 ro; mkdir d",
        "ln f ro/hard",
        "ln -s f ro/soft",
        "ln f rw/c",
        "ln -s f rw/c",
        "ln nope h",
        "ln d hd",
        "ln f g ro",
        "echo $?",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "ln: failed to create hard link 'ro/hard' => 'f': Permission denied",
        "ln: failed to create symbolic link 'ro/soft': Permission denied",
        "ln: failed to create hard link 'rw/c': File exists",
        "ln: failed to create symbolic link 'rw/c': File exists",
        "ln: failed to access 'nope': No such file or directory",
        "ln: d: hard link not allowed for directory",
        "ln: failed to create hard link 'ro/f' => 'f': Permission denied",
        "ln: failed to access 'g': No such file or directory",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("1\n");
  });

  it("cp names a target it may not look at, and its last operand when that is no directory", async () => {
    const result = await sh(
      [
        "mkdir nx; chmod 644 nx",
        "cp f nx/",
        "cp f nx/new",
        "cp f rw/c/x",
        "cp f rw/c nope",
        "cp f rw/c f",
        "cp f rw/c nx/in/x",
        "echo $?",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "cp: cannot stat 'nx/f': Permission denied",
        "cp: cannot stat 'nx/new': Permission denied",
        "cp: cannot stat 'rw/c/x': Not a directory",
        "cp: target 'nope': No such file or directory",
        "cp: target 'f': Not a directory",
        "cp: target 'nx/in/x': Permission denied",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("1\n");
  });

  it("cp -v says what it copies before it tries, and for each entry of a tree", async () => {
    const result = await sh(
      "chmod 555 ro; cp -v f rw/c ro//; echo $?; mkdir -p t/sub; echo x > t/sub/x; cp -rv t v; cp -rv t v",
      { files },
    );
    expect(result.out).toBe(
      [
        "'f' -> 'ro/f'",
        "'rw/c' -> 'ro/c'",
        "1",
        "'t' -> 'v'",
        "'t/sub' -> 'v/sub'",
        "'t/sub/x' -> 'v/sub/x'",
        "'t' -> 'v/t'",
        "'t/sub' -> 'v/t/sub'",
        "'t/sub/x' -> 'v/t/sub/x'",
        "",
      ].join("\n"),
    );
    expect(result.err).toBe(
      "cp: cannot create regular file 'ro/f': Permission denied\n" +
        "cp: cannot create regular file 'ro/c': Permission denied\n",
    );
  });

  it("cp and mv do not put a file where a directory is, nor a directory where a file is", async () => {
    const result = await sh(
      "mkdir d; cp -r d f; cp -T f d; mv d f; mv -T f d; echo $?; mkdir -p e/d; touch e/d/x; mv d e; echo $?",
      { files },
    );
    expect(result.err).toBe(
      [
        "cp: cannot overwrite non-directory 'f' with directory 'd'",
        "cp: cannot overwrite directory 'd' with non-directory 'f'",
        "mv: cannot overwrite non-directory 'f' with directory 'd'",
        "mv: cannot overwrite directory 'd' with non-directory 'f'",
        "mv: cannot overwrite 'e/d': Directory not empty",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("1\n1\n");
  });

  it("sort checks its inputs and its output file before it reads, and exits 2", async () => {
    const result = await sh(
      [
        "echo x > r; chmod 444 r; chmod 0 ro/a; mkdir d",
        "sort f -o r; echo $?; cat r",
        "sort f -o ro/sub/../out; echo $?",
        "sort ro/a f; echo $?",
        "sort f nope -o made; echo $?; ls made",
        "sort d; echo $?",
        "printf 'b\\na\\n' > in; sort -o in in; echo $?; cat in",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "sort: open failed: r: Permission denied",
        "sort: cannot read: ro/a: Permission denied",
        "sort: cannot read: nope: No such file or directory",
        "ls: cannot access 'made': No such file or directory",
        "sort: read failed: d: Is a directory",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("2\nx\n0\n2\n2\n2\n0\na\nb\n");
  });

  it("grep -r names the entries it may not look at", async () => {
    const result = await sh(
      "mkdir nr nx; echo i > nr/in; echo i > nx/in; mkdir nx/sub; echo i > rw/in; " +
        "chmod 311 nr; chmod 644 nx; grep -r i nr nx rw; echo $?; grep -rs i nx; echo $?; grep i nx/in; echo $?",
      { files },
    );
    expect(result.err).toBe(
      [
        "grep: nr: Permission denied",
        "grep: nx/in: Permission denied",
        "grep: nx/sub: Permission denied",
        "grep: nx/in: Permission denied",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("rw/in:i\n2\n2\n2\n");
  });

  it("ls -a looks . and .. up in the directory, which one it may not search refuses", async () => {
    const result = await sh("chmod 644 ro; ls -la ro | cut -c1-10; ls -a ro; echo $?", { files });
    expect(result.err).toBe(
      [
        "ls: cannot access 'ro/.': Permission denied",
        "ls: cannot access 'ro/..': Permission denied",
        "ls: cannot access 'ro/a': Permission denied",
        "ls: cannot access 'ro/sub': Permission denied",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe(
      "total 0\nd?????????\nd?????????\n-?????????\nd?????????\n.\n..\na\nsub\n0\n",
    );
  });
});

describe("the mode cp leaves", () => {
  // GNU cp 9.5 on the same files.
  it("is the destination's own when it was there, and the source's for a new file", async () => {
    const result = await sh(
      [
        "echo ro > r; chmod 444 r; echo w > w; cp r w; echo $?",
        "echo more >> w; echo $?; cat w",
        "echo x > x; chmod 755 x; echo p > p; cp x p",
        "cp r newr; cp x newx",
        "chmod 4755 x; cp x plain; cp -p x kept; cp -p r w",
        "ls -l w p newr newx plain kept | cut -c1-10",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe("");
    expect(result.out).toBe(
      [
        "0",
        "0",
        "ro",
        "more",
        "-rwsr-xr-x", // kept: -p keeps every bit
        "-r--r--r--", // newr
        "-rwxr-xr-x", // newx
        "-rw-r--r--", // p: was there
        "-rwxr-xr-x", // plain: a new file does not get setuid
        "-r--r--r--", // w: -p set the source's mode on it
        "",
      ].join("\n"),
    );
  });

  it("is the source's again when -f had to remove the destination", async () => {
    const result = await sh(
      "echo ro > r; chmod 444 r; echo w > w; chmod 0 w; cp r w; echo $?; cp -f r w; echo $?; " +
        "ls -l w | cut -c1-10; cat w",
      { files },
    );
    expect(result.err).toBe("cp: cannot create regular file 'w': Permission denied\n");
    expect(result.out).toBe("1\n0\n-r--r--r--\nro\n");
  });

  it("writes through a link to a file and refuses one that points nowhere", async () => {
    const result = await sh(
      "echo t > target; chmod 600 target; ln -s target lnk; ln -s nowhere dangling; " +
        "cp f lnk; cp f dangling; echo $?; cat target; ls -l target lnk | cut -c1-10; ls nowhere",
      { files },
    );
    expect(result.err).toBe(
      "cp: not writing through dangling symlink 'dangling'\n" +
        "ls: cannot access 'nowhere': No such file or directory\n",
    );
    expect(result.out).toBe("1\nflrwxrwxrwx\n-rw-------\n");
  });

  it("copies an operand that is a link as a link with -r or -P, and through it otherwise", async () => {
    const result = await sh(
      "ln -s f lnk; ln -s nowhere dangling; cp lnk a; cp -P lnk b; cp -r lnk c; cp -r dangling d; " +
        "cp dangling e; echo $?; ls -l a b c d | cut -c1-10",
      { files },
    );
    expect(result.err).toBe("cp: cannot stat 'dangling': No such file or directory\n");
    expect(result.out).toBe("1\n-rw-r--r--\nlrwxrwxrwx\nlrwxrwxrwx\nlrwxrwxrwx\n");
    const dirs = await sh(
      "ln -s ro dl; cp -r dl asLink; cp -r dl/ bySlash; cp -rL dl byL; ls -ld asLink bySlash byL | cut -c1-10; ls byL",
      { files },
    );
    expect(dirs.err).toBe("");
    expect(dirs.out).toBe("lrwxrwxrwx\ndrwxr-xr-x\ndrwxr-xr-x\na\nsub\n");
  });
});

describe("touch", () => {
  it("passes over only a missing file with -c, and says why it cannot set another's times", async () => {
    // GNU touch 9.5 on the same tree: -c ignores only ENOENT.
    const result = await sh(
      [
        "mkdir nx; touch nx/x; chmod 644 nx; chmod 555 ro; echo r > r; chmod 444 r",
        "for c in '-c nx/x' nx/x '-c missing' '-c ro/missing' ro/new '-c f/x' f/x r '-c r' rw '-c rw' '-c nx'; do touch $c; echo \"$c=$?\"; done",
        "ls",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "touch: setting times of 'nx/x': Permission denied",
        "touch: cannot touch 'nx/x': Permission denied",
        "touch: cannot touch 'ro/new': Permission denied",
        "touch: setting times of 'f/x': Not a directory",
        "touch: cannot touch 'f/x': Not a directory",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe(
      [
        "-c nx/x=1",
        "nx/x=1",
        "-c missing=0",
        "-c ro/missing=0",
        "ro/new=1",
        "-c f/x=1",
        "f/x=1",
        "r=0",
        "-c r=0",
        "rw=0",
        "-c rw=0",
        "-c nx=0",
        "f",
        "nx",
        "r",
        "ro",
        "rw",
        "",
      ].join("\n"),
    );
  });
});

describe("touch -a and -m", () => {
  it("change only the access or only the modification time, as GNU touch 9.5", async () => {
    const d2001 = Date.parse("2001-01-01 00:00:00");
    const d2002 = Date.parse("2002-02-02 00:00:00");
    const d2004 = Date.parse("2004-01-01 00:00:00");
    const D = (date: string) => `-d '${date}'`;
    const result = await sh(
      [
        `touch ${D("2001-01-01 00:00:00")} a m am; touch -a a; touch -m m; touch -am am`,
        `touch ${D("2001-01-01 00:00:00")} da dm; touch -a ${D("2002-02-02 00:00:00")} da; touch -m ${D("2002-02-02 00:00:00")} dm`,
        `touch ${D("2001-01-01 00:00:00")} ref; touch -m ${D("2002-02-02 00:00:00")} ref`,
        `touch ${D("2004-01-01 00:00:00")} r ra rm; touch -r ref r; touch -a -r ref ra; touch -m -r ref rm`,
        "touch -a -c missing; echo c=$?; touch -m new; echo new=$?",
      ].join("; "),
      { files },
    );
    expect({ out: result.out, err: result.err }).toEqual({ out: "c=0\nnew=0\n", err: "" });
    const times = (name: string) => {
      const stat = result.vfs.stat(`/work/${name}`, true);
      const shown = (ms: number) => (Math.abs(ms - Date.now()) < 60000 ? "now" : ms);
      return [shown(stat.atimeMs), shown(stat.mtimeMs)];
    };
    expect({
      a: times("a"),
      m: times("m"),
      am: times("am"),
      da: times("da"),
      dm: times("dm"),
      r: times("r"),
      ra: times("ra"),
      rm: times("rm"),
      new: times("new"),
    }).toEqual({
      a: ["now", d2001],
      m: [d2001, "now"],
      am: ["now", "now"],
      da: [d2002, d2001],
      dm: [d2001, d2002],
      r: [d2001, d2002],
      ra: [d2001, d2004],
      rm: [d2004, d2002],
      new: ["now", "now"],
    });
    expect(result.vfs.exists("/work/missing")).toBe(false);
  });
});

describe("touch on /dev", () => {
  it("sets a device's times to now, which needs only write access, and not /dev's", async () => {
    // Linux: `touch /dev/null` is 0 for a user; /dev is root's and not theirs to write.
    const shell = kernelShell(["sh", "-c", "touch /dev/null; echo $?; touch /dev; echo $?"]);
    await shell.done;
    expect(shell.output()).toBe(
      ["0", "touch: setting times of '/dev': Permission denied", "1", ""].join("\n"),
    );
  });

  it("refuses -a and -m on a device root owns: one time left alone needs the owner", async () => {
    // Linux: utimensat(2) with UTIME_NOW and UTIME_OMIT is EPERM for a user on /dev/null.
    const shell = kernelShell([
      "sh",
      "-c",
      "touch -a /dev/null; echo $?; touch -m -c /dev/null; echo $?; touch -am /dev/null; echo $?",
    ]);
    await shell.done;
    expect(shell.output()).toBe(
      [
        "touch: setting times of '/dev/null': Operation not permitted",
        "1",
        "touch: setting times of '/dev/null': Operation not permitted",
        "1",
        "0",
        "",
      ].join("\n"),
    );
  });
});

describe("mv", () => {
  it("names the target it computed in a directory, as GNU mv does", async () => {
    // GNU mv 9.5 on the same tree.
    const result = await sh(
      [
        "chmod 555 ro; mkdir a; touch out x y z",
        "for c in 'out ro/' 'out ro' 'out ro//' 'ro/a .' 'ro/a ./' 'ro/a rw/../.' 'a a/' 'a a' 'x .' 'x ./' 'x x' '-v y rw/' '-v z rw'; do mv $c; echo \"$c=$?\"; done",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "mv: cannot move 'out' to 'ro/out': Permission denied",
        "mv: cannot move 'out' to 'ro/out': Permission denied",
        "mv: cannot move 'out' to 'ro/out': Permission denied",
        "mv: cannot overwrite directory './a' with non-directory 'ro/a'",
        "mv: cannot overwrite directory './a' with non-directory 'ro/a'",
        "mv: cannot overwrite directory 'rw/.././a' with non-directory 'ro/a'",
        "mv: cannot move 'a' to a subdirectory of itself, 'a/a'",
        "mv: cannot move 'a' to a subdirectory of itself, 'a/a'",
        "mv: 'x' and './x' are the same file",
        "mv: 'x' and './x' are the same file",
        "mv: 'x' and 'x' are the same file",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe(
      [
        "out ro/=1",
        "out ro=1",
        "out ro//=1",
        "ro/a .=1",
        "ro/a ./=1",
        "ro/a rw/../.=1",
        "a a/=1",
        "a a=1",
        "x .=1",
        "x ./=1",
        "x x=1",
        "renamed 'y' -> 'rw/y'",
        "-v y rw/=0",
        "renamed 'z' -> 'rw/z'",
        "-v z rw=0",
        "",
      ].join("\n"),
    );
  });
});

describe("cp", () => {
  it("names the target it computed in a directory, as GNU cp does", async () => {
    // GNU cp 9.5 on the same tree.
    const result = await sh(
      [
        "chmod 555 ro; mkdir d; touch d/x",
        "for c in 'f ro/' 'f ro' 'f ro//' 'f .' 'f ./' '-v f rw/' '-v f rw//' '-v f rw' '-r d d/' '-r d d' '-v f rw/../rw/' 'f f'; do cp $c; echo \"$c=$?\"; done",
      ].join("; "),
      { files },
    );
    expect(result.err).toBe(
      [
        "cp: cannot create regular file 'ro/f': Permission denied",
        "cp: cannot create regular file 'ro/f': Permission denied",
        "cp: cannot create regular file 'ro/f': Permission denied",
        "cp: 'f' and './f' are the same file",
        "cp: 'f' and './f' are the same file",
        "cp: cannot copy a directory, 'd', into itself, 'd/d'",
        "cp: cannot copy a directory, 'd', into itself, 'd/d'",
        "cp: 'f' and 'f' are the same file",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe(
      [
        "f ro/=1",
        "f ro=1",
        "f ro//=1",
        "f .=1",
        "f ./=1",
        "'f' -> 'rw/f'",
        "-v f rw/=0",
        "'f' -> 'rw/f'",
        "-v f rw//=0",
        "'f' -> 'rw/f'",
        "-v f rw=0",
        "-r d d/=1",
        "-r d d=1",
        "'f' -> 'rw/../rw/f'",
        "-v f rw/../rw/=0",
        "f f=1",
        "",
      ].join("\n"),
    );
  });
});

describe("cd", () => {
  it("says why it cannot change directory, and needs search on the directory, as bash does", async () => {
    const result = await sh(
      "mkdir nx; chmod 600 nx; cd nx; echo $?; cd f; echo $?; cd missing; echo $?; " +
        "mkdir -p anc/in; chmod 600 anc; cd anc/in; echo $?; pwd; chmod 100 nx; cd nx; pwd",
      { files },
    );
    expect(result.err).toBe(
      [
        "sh: cd: nx: Permission denied",
        "sh: cd: f: Not a directory",
        "sh: cd: missing: No such file or directory",
        "sh: cd: anc/in: Permission denied",
        "",
      ].join("\n"),
    );
    expect(result.out).toBe("1\n1\n1\n1\n/work\n/work/nx\n");
  });
});

describe("running a command", () => {
  /** `sh -c line` on the kernel, whose own exec answers the spawns. */
  async function run(line: string): Promise<string> {
    const shell = kernelShell(["sh", "-c", line]);
    await shell.done;
    return shell.output();
  }

  it("says what bash says for a directory and for a file that cannot run", async () => {
    const output = await run(
      [
        "mkdir -p d bin/dir",
        "./d; echo s=$?",
        "echo 'echo hi' > plain; ./plain; echo s=$?",
        "printf '#!/bin/sh\\n' > bin/tool; PATH=bin:$PATH tool; echo s=$?",
        "PATH=$PWD/bin:$PATH dir; echo s=$?",
      ].join("; "),
    );
    expect(output).toBe(
      [
        "sh: ./d: Is a directory",
        "s=126",
        "sh: ./plain: Permission denied",
        "s=126",
        "sh: bin/tool: Permission denied",
        "s=126",
        "sh: command not found: dir",
        "s=127",
        "",
      ].join("\n"),
    );
  });

  it("starts a command where the shell is without changing into it, as a fork does", async () => {
    const seen: SpawnRequest[] = [];
    const result = await sh("mkdir in; cd in; chmod 600 .; node x; echo s=$?", {
      files,
      spawn: (request) => {
        seen.push(request);
        return 0;
      },
    });
    expect(result.out).toBe("s=0\n");
    expect(seen.map((request) => [request.cwd, request.inheritCwd])).toEqual([["/work/in", true]]);
  });
});

describe("sed -i", () => {
  it("writes a new file beside the original and renames it over, as GNU sed does", async () => {
    const result = await sh(
      "echo a > f2; chmod 444 f2; sed -i s/a/b/ f2; echo $?; cat f2; ls -l f2; " +
        "sed -i.bak s/b/c/ f2; echo $?; cat f2 f2.bak; ls -l f2.bak; ls",
      { files },
    );
    expect(result.err).toBe("");
    expect(result.out).toMatch(
      /^0\nb\n-r--r--r-- .* f2\n0\nc\nb\n-r--r--r-- .* f2\.bak\nf\nf2\nf2\.bak\nro\nrw\n$/,
    );
  });

  it("leaves a file in a directory it cannot write alone, and stops there", async () => {
    const result = await sh("chmod 555 ro; sed -i s/a/A/ ro/a f; echo $?; cat ro/a f; ls ro", {
      files,
    });
    expect(result.err).toMatch(
      /^sed: couldn't open temporary file ro\/sed[A-Za-z0-9]{6}: Permission denied\n$/,
    );
    expect(result.out).toBe("4\nafa\nsub\n");
  });

  it("says it cannot read a file it may not read, and goes on", async () => {
    const result = await sh("chmod 0 ro/a; sed -i s/f/F/ ro/a f; echo $?; cat f", { files });
    expect(result.err).toBe("sed: can't read ro/a: Permission denied\n");
    expect(result.out).toBe("2\nF");
  });
});

describe("cp -f", () => {
  it("removes a destination it cannot open and copies again, as GNU cp does", async () => {
    const result = await sh(
      "echo dst > d; chmod 444 d; cp f d; echo $?; cp -f f d; echo $?; cat d; ls -l d; " +
        "mkdir -p t; echo v1 > t/ro; chmod 444 t/ro; cp -r t copy; echo v2 > t/ro2; " +
        "chmod 644 t/ro; echo v2 > t/ro; chmod 444 t/ro; cp -rf t/. copy; echo $?; cat copy/ro",
      { files },
    );
    expect(result.err).toBe("cp: cannot create regular file 'd': Permission denied\n");
    expect(result.out).toMatch(/^1\n0\nf-rw-r--r-- .* d\n0\nv2\n$/);
  });

  it("says it cannot remove what its directory refuses", async () => {
    const result = await sh("chmod 444 ro/a; chmod 555 ro; cp -f f ro/a; echo $?; cat ro/a", {
      files,
    });
    expect(result.err).toBe("cp: cannot remove 'ro/a': Permission denied\n");
    expect(result.out).toBe("1\na");
  });
});
