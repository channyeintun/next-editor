// @vitest-environment node
// What a command's operand names: the filesystem gets the path as it was
// written, so an empty operand names nothing (never the working directory),
// `..` is resolved after the links before it and through directories that
// must be searchable, and a trailing slash keeps its meaning. The messages
// are GNU coreutils 9.5's.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { readText, sh } from "../testHelpers";
import { absolutePath, quoteName } from "./util";

afterEach(() => {
  setRuntime(null);
});

const files = { "/work/proj/file.txt": "keep\n", "/work/proj/sub/deep.txt": "k2\n" };
const cwd = "/work/proj";
/** Every entry under /work/proj, to show nothing was touched. */
const LEFT = ".:\nfile.txt\nsub\n\n./sub:\ndeep.txt\n";

describe("absolutePath", () => {
  it("joins a relative path to the working directory and resolves nothing in it", () => {
    expect(absolutePath("/work", "a/../b/")).toBe("/work/a/../b/");
    expect(absolutePath("/", "a")).toBe("/a");
    expect(absolutePath("/work", "/x/./y")).toBe("/x/./y");
  });

  it("keeps an empty path empty", () => {
    expect(absolutePath("/work", "")).toBe("");
  });
});

describe("quoteName", () => {
  it("quotes a name as GNU cat does in `cat: NAME: No such file or directory`", () => {
    // Each pair is what gcat 9.5 printed for the name.
    const cases: [string, string][] = [
      ["", "''"],
      ["plain.txt", "plain.txt"],
      ["a b", "'a b'"],
      ["a'b", `"a'b"`],
      ["a'b c", `"a'b c"`],
      ['a"b', `'a"b'`],
      ["a'b$c", "'a'\\''b$c'"],
      ["a:b", "'a:b'"],
      ["#x", "'#x'"],
      ["x#y", "x#y"],
      ["~x", "'~x'"],
      ["x~y", "x~y"],
      ["{", "'{'"],
      ["{}", "{}"],
      ["a{b}", "a{b}"],
      ["a=b", "'a=b'"],
      ["a?b", "'a?b'"],
      ["a*b", "'a*b'"],
      ["a\\b", "'a\\b'"],
      ["a]b", "a]b"],
      ["a[b", "'a[b'"],
      ["a,b+c@d%e", "a,b+c@d%e"],
      ["-x", "-x"],
      ["a\nb", "'a'$'\\n''b'"],
      ["a\tb", "'a'$'\\t''b'"],
    ];
    for (const [name, shown] of cases) {
      expect(quoteName(name)).toBe(shown);
    }
  });
});

describe("an empty operand", () => {
  it("is never the working directory for rm, whatever the flags", async () => {
    const result = await sh(
      'rm ""; echo $?; rm -f ""; echo $?; rm -r ""; echo $?; rm -rf "$UNSET"; echo $?; rm -d ""; echo $?; ls -R',
      { files, cwd },
    );
    expect(result.err).toBe(
      "rm: cannot remove '': No such file or directory\n" +
        "rm: cannot remove '': No such file or directory\n" +
        "rm: cannot remove '': No such file or directory\n",
    );
    expect(result.out).toBe(`1\n0\n1\n0\n1\n${LEFT}`);
  });

  it("does not stop rm from removing its other operands", async () => {
    const result = await sh('rm -rf "" file.txt; echo $?; ls', { files, cwd });
    expect(result.err).toBe("");
    expect(result.out).toBe("0\nsub\n");
  });

  it("is not found by the commands that change or remove files", async () => {
    const result = await sh(
      [
        'rmdir ""',
        'rmdir -p ""',
        'mkdir ""',
        'mkdir -p ""',
        'touch ""',
        'touch -c ""; echo "touch -c $?"',
        'touch -r "" x',
        'chmod 700 ""',
        'chmod -R a-w ""',
        'cp -r "" copy',
        'cp "" copy',
        'cp file.txt ""',
        'cp file.txt sub/deep.txt ""',
        'mv "" moved',
        'mv file.txt ""',
        'mv file.txt sub/deep.txt ""',
        'ln -s file.txt ""',
        'ln file.txt ""',
        'ln "" hard',
        'sed -i s/k/K/ ""',
        'find "" -name "*.txt" -delete',
        "echo last=$?",
        "ls -R",
        "ls -ld . file.txt | cut -c1-10",
        "ls /work",
      ].join("; "),
      { files, cwd },
    );
    expect(result.err).toBe(
      "rmdir: failed to remove '': No such file or directory\n" +
        "rmdir: failed to remove '': No such file or directory\n" +
        "mkdir: cannot create directory '': No such file or directory\n" +
        "mkdir: cannot create directory '': No such file or directory\n" +
        "touch: cannot touch '': No such file or directory\n" +
        "touch: failed to get attributes of '': No such file or directory\n" +
        "chmod: cannot access '': No such file or directory\n" +
        "chmod: cannot access '': No such file or directory\n" +
        "cp: cannot stat '': No such file or directory\n" +
        "cp: cannot stat '': No such file or directory\n" +
        "cp: cannot create regular file '': No such file or directory\n" +
        "cp: target '': No such file or directory\n" +
        "mv: cannot stat '': No such file or directory\n" +
        "mv: cannot move 'file.txt' to '': No such file or directory\n" +
        "mv: target '': No such file or directory\n" +
        "ln: failed to create symbolic link '': No such file or directory\n" +
        "ln: failed to create hard link '' => 'file.txt': No such file or directory\n" +
        "ln: failed to access '': No such file or directory\n" +
        "sed: can't read : No such file or directory\n" +
        "find: '': No such file or directory\n",
    );
    expect(result.out).toBe(`touch -c 0\nlast=1\n${LEFT}drwxr-xr-x\n-rw-r--r--\nproj\n`);
  });

  it("is not found by the commands that read files", async () => {
    const result = await sh(
      [
        'ls ""; echo "ls $?"',
        'ls -la ""; echo "ls -la $?"',
        'ls "" file.txt; echo "ls two $?"',
        'cat "" file.txt; echo "cat $?"',
        'head -n 1 ""; echo "head $?"',
        'tail -n 1 ""; echo "tail $?"',
        'wc -l ""; echo "wc $?"',
        'sort ""; echo "sort $?"',
        'sort -o "" file.txt; echo "sort -o $?"',
        'uniq ""; echo "uniq $?"',
        'cut -c1 ""; echo "cut $?"',
        'grep k ""; echo "grep $?"',
        'grep -r k ""; echo "grep -r $?"',
        'echo x | tee ""; echo "tee $?"',
        'readlink ""; echo "readlink $?"',
        'readlink -f ""; echo "readlink -f $?"',
        'realpath ""; echo "realpath $?"',
      ].join("; "),
      { files, cwd },
    );
    expect(result.err).toBe(
      "ls: cannot access '': No such file or directory\n" +
        "ls: cannot access '': No such file or directory\n" +
        "ls: cannot access '': No such file or directory\n" +
        "cat: '': No such file or directory\n" +
        "head: cannot open '' for reading: No such file or directory\n" +
        "tail: cannot open '' for reading: No such file or directory\n" +
        "wc: invalid zero-length file name\n" +
        "sort: cannot read: '': No such file or directory\n" +
        "sort: open failed: '': No such file or directory\n" +
        "uniq: '': No such file or directory\n" +
        "cut: '': No such file or directory\n" +
        "grep: : No such file or directory\n" +
        "grep: : No such file or directory\n" +
        "tee: '': No such file or directory\n" +
        "realpath: '': No such file or directory\n",
    );
    expect(result.out).toBe(
      "ls 2\nls -la 2\nfile.txt\nls two 2\nkeep\ncat 1\nhead 1\ntail 1\nwc 1\nsort 2\nsort -o 2\n" +
        "uniq 1\ncut 1\ngrep 2\ngrep -r 2\nx\ntee 1\nreadlink 1\nreadlink -f 1\nrealpath 1\n",
    );
  });

  it("is no file to the tests of [", async () => {
    const result = await sh(
      '[ -d "" ]; echo $?; [ -e "" ]; echo $?; [ -r "" ]; echo $?; ' +
        '[ "" -nt file.txt ]; echo $?; [ file.txt -nt "" ]; echo $?; [ "" -ot file.txt ]; echo $?',
      { files, cwd },
    );
    expect(result.out).toBe("1\n1\n1\n1\n0\n0\n");
  });
});

describe("a path with .. in it", () => {
  const linked = {
    "/work/dd/x": "outer\n",
    "/work/dd/d/x": "inner\n",
    "/work/dd/d/sub/s": "s\n",
  };

  it("leaves a linked directory through the directory the link points into", async () => {
    const result = await sh(
      [
        "ln -s d/sub link",
        "cat link/../x",
        "[ -d link/../sub ] && echo dir",
        "ls link/..",
        "cp link/../x copied; cat copied",
        "head -n 1 link/../x",
        "grep -c inner link/../x",
        "cd link; cat ../x; cd ..",
        "rm -f link/../x; ls x d/x",
      ].join("; "),
      { files: linked, cwd: "/work/dd" },
    );
    expect(result.err).toBe("ls: cannot access 'd/x': No such file or directory\n");
    expect(result.out).toBe("inner\ndir\nsub\nx\ninner\ninner\n1\ninner\nx\n");
  });

  it("needs search on the directory it goes through and comes back out of", async () => {
    const result = await sh(
      [
        "mkdir -p nx/sub; echo hi > f; chmod 000 nx",
        "cat nx/../f; echo cat=$?",
        "ls nx/..; echo ls=$?",
        "[ -f nx/../f ]; echo test=$?",
        "cp nx/../f g; echo cp=$?",
        "rm nx/../f; echo rm=$?",
        "ls",
      ].join("; "),
      { cwd: "/work" },
    );
    expect(result.err).toBe(
      "cat: nx/../f: Permission denied\n" +
        "ls: cannot access 'nx/..': Permission denied\n" +
        "cp: cannot stat 'nx/../f': Permission denied\n" +
        "rm: cannot remove 'nx/../f': Permission denied\n",
    );
    expect(result.out).toBe("cat=1\nls=2\ntest=1\ncp=1\nrm=1\nf\nnx\n");
  });
});

describe("a trailing slash", () => {
  it("names the directory a link points to, which rm does not remove without -r", async () => {
    const result = await sh(
      "mkdir -p r2/x; ln -s r2 r2link; rm r2link/; echo $?; ls -d r2 r2/x r2link",
      { cwd: "/work" },
    );
    expect(result.err).toBe("rm: cannot remove 'r2link/': Is a directory\n");
    expect(result.out).toBe("1\nr2\nr2/x\nr2link\n");
  });

  it("makes cp and mv fail when the directory is not there", async () => {
    const result = await sh(
      "echo f > plain; cp plain nodir/; echo $?; mv plain nodir/; echo $?; ls",
      { cwd: "/work" },
    );
    expect(result.err).toBe(
      "cp: cannot create regular file 'nodir/': Not a directory\n" +
        "mv: cannot move 'plain' to 'nodir/': Not a directory\n",
    );
    expect(result.out).toBe("1\n1\nplain\n");
  });

  it("is refused on a file, and accepted on a directory", async () => {
    const result = await sh(
      "echo f > plain; mkdir d; cat plain/; echo $?; cp plain d/; echo $?; ls d/; rm plain/; echo $?",
      { cwd: "/work" },
    );
    expect(result.err).toBe(
      "cat: plain/: Not a directory\nrm: cannot remove 'plain/': Not a directory\n",
    );
    expect(result.out).toBe("1\n0\nplain\n1\n");
  });
});

describe("rm", () => {
  it("refuses the root however it is spelled", async () => {
    const result = await sh(
      "cd /work; ln -s / top; rm -rf proj/../..; rm -rf // top/; rm -r /; rm /; echo $?; ls /work",
      { files },
    );
    expect(result.err).toBe(
      "rm: refusing to remove '.' or '..' directory: skipping 'proj/../..'\n" +
        "rm: it is dangerous to operate recursively on '//' (same as '/')\n" +
        "rm: use --no-preserve-root to override this failsafe\n" +
        "rm: it is dangerous to operate recursively on 'top/' (same as '/')\n" +
        "rm: use --no-preserve-root to override this failsafe\n" +
        "rm: it is dangerous to operate recursively on '/'\n" +
        "rm: use --no-preserve-root to override this failsafe\n" +
        "rm: cannot remove '/': Is a directory\n",
    );
    expect(result.out).toBe("1\nproj\ntop\n");
  });

  it("removes through a link to a directory only what the path names", async () => {
    const result = await sh(
      "mkdir -p real/in; ln -s real link; rm -r link/in; ls real; ls -d link",
      {
        cwd: "/work",
      },
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("link\n");
  });
});

describe("cp and mv", () => {
  it("know one file by what it is, not by how its path is spelled", async () => {
    const result = await sh(
      "ln -s . here; cp file.txt here/file.txt; echo $?; mv file.txt ./sub/../file.txt; echo $?; cat file.txt",
      { files, cwd },
    );
    expect(result.err).toBe(
      "cp: 'file.txt' and 'here/file.txt' are the same file\n" +
        "mv: 'file.txt' and './sub/../file.txt' are the same file\n",
    );
    expect(result.out).toBe("1\n1\nkeep\n");
  });

  it("do not copy or move a directory into itself, however the target is spelled", async () => {
    const result = await sh(
      "ln -s sub alias; cp -r sub alias/inside; echo $?; mv sub alias/moved; echo $?; ls sub sub/inside",
      { files, cwd },
    );
    expect(result.err).toBe(
      "cp: will not create hard link 'alias/inside/inside' to directory 'alias/inside'\n" +
        "mv: cannot move 'sub' to a subdirectory of itself, 'alias/moved'\n",
    );
    expect(result.out).toBe("1\n1\nsub:\ndeep.txt\ninside\n\nsub/inside:\ndeep.txt\n");
  });

  it("stop a copy of a directory into itself where it meets its own copy", async () => {
    const result = await sh("cp -r . sub/all; echo $?; cp -r sub sub/again; echo $?; ls -R sub", {
      files,
      cwd,
    });
    expect(result.err).toBe(
      "cp: cannot copy a directory, '.', into itself, 'sub/all'\n" +
        "cp: cannot copy a directory, 'sub', into itself, 'sub/again'\n",
    );
    expect(result.out).toBe(
      "1\n1\nsub:\nagain\nall\ndeep.txt\n\nsub/again:\n\nsub/all:\nfile.txt\nsub\n\nsub/all/sub:\n",
    );
  });

  it("write the file the path names", async () => {
    const result = await sh("ln -s sub link; cp file.txt link/../via; cat via", { files, cwd });
    expect(result.err).toBe("");
    expect(readText(result.vfs, "/work/proj/via")).toBe("keep\n");
  });
});
