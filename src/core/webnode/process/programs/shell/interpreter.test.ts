// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { readText, sh } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

async function out(script: string | string[], options = {}): Promise<string> {
  return (await sh(script, options)).out;
}

describe("quoting and expansion", () => {
  it("handles quotes, escapes and ANSI-C strings", async () => {
    expect(await out(`echo 'a  b' "c  d" e\\ \\ f $'x\\ty' "q\\"uote" 'it'\\''s'`)).toBe(
      "a  b c  d e  f x\ty q\"uote it's\n",
    );
  });

  it("expands parameters with every operator", async () => {
    const script = [
      "unset u; e=; v=value; path=/a/b/c.tar.gz",
      'echo "${u:-d1} ${e:-d2} ${e-d3} ${v:+alt} ${u+alt}x"',
      'echo "${#v} ${path%.*} ${path%%.*} ${path#*/} ${path##*/}"',
      'echo "${u:=assigned} $u"',
      'echo "${v/al/AL} ${v//e/E} ${v:1:3} ${v: -2} ${v^^}"',
    ].join("\n");
    expect(await out(script)).toBe(
      "d1 d2  alt x\n5 /a/b/c.tar /a/b/c a/b/c.tar.gz c.tar.gz\nassigned assigned\nvALue valuE alu ue VALUE\n",
    );
  });

  it("fails on ${x:?message}", async () => {
    const result = await sh('echo "${missing:?is required}"; echo after');
    expect(result.status).toBe(1);
    expect(result.err).toContain("missing: is required");
    expect(result.out).toBe("");
  });

  it("expands special parameters and sh -c arguments", async () => {
    expect(await out(["sh", "-c", 'echo "$0|$1|$2|$#|$*"', "name", "a b", "c"])).toBe(
      "name|a b|c|2|a b c\n",
    );
    expect(
      await out(["sh", "-c", 'for a in "$@"; do echo "[$a]"; done', "x", "1 2", "", "3"]),
    ).toBe("[1 2]\n[]\n[3]\n");
    expect(await out(["sh", "-c", 'set -- "$@"; echo $#', "x"])).toBe("0\n");
    expect(await out("false; echo $?; true; echo $?")).toBe("1\n0\n");
  });

  it("splits unquoted expansions on IFS", async () => {
    expect(await out('x="a  b   c"; argv $x; argv "$x"', {})).toBe("<a><b><c>\n<a  b   c>\n");
    expect(await out('IFS=:; x="a::b"; argv $x')).toBe("<a><><b>\n");
    expect(await out('x=""; argv $x "$x" x$x')).toBe("<><x>\n");
  });

  it("runs command substitution and strips trailing newlines", async () => {
    expect(await out('x=$(echo hi; echo there); echo "[$x]"; echo `echo back`')).toBe(
      "[hi\nthere]\nback\n",
    );
    expect(await out('echo "$(printf "a\\n\\n\\n")|"')).toBe("a|\n");
    expect(await out("echo $(node -v)")).toBe("node -v\n");
    expect(await out("x=$(exit 3); echo $?")).toBe("3\n");
  });

  it("evaluates arithmetic", async () => {
    expect(
      await out(
        "i=5; echo $((i * 2 + 1)) $(( (1+2)*3 )) $((7 / 2)) $((7 % 3)) $((i > 3 && i < 10)) $((i == 5 ? 10 : 20)) $((2**10)) $((0x10)) $((010))",
      ),
    ).toBe("11 9 3 1 1 10 1024 16 8\n");
    expect(await out("i=0; i=$((i+1)); : $((i+=5)); echo $i; ((i++)); echo $i")).toBe("6\n7\n");
    const result = await sh("echo $((1/0))");
    expect(result.status).toBe(1);
    expect(result.err).toContain("division by 0");
  });

  it("expands tilde, braces and globs", async () => {
    const files = {
      "/work/a.js": "",
      "/work/b.js": "",
      "/work/c.ts": "",
      "/work/.hidden.js": "",
      "/work/src/x.js": "",
    };
    expect(await out("echo ~ ~/x", { files })).toBe("/home /home/x\n");
    expect(await out("echo {a,b}{1,2} x{1..3} {c..a} {01..03} {a}", { files })).toBe(
      "a1 a2 b1 b2 x1 x2 x3 c b a 01 02 03 {a}\n",
    );
    expect(
      await out("echo *.js; echo ?.ts; echo [ab].js; echo */*.js; echo *.none; echo '*.js'", {
        files,
      }),
    ).toBe("a.js b.js\nc.ts\na.js b.js\nsrc/x.js\n*.none\n*.js\n");
    expect(await out("set -f; echo *.js", { files })).toBe("*.js\n");
  });
});

describe("commands and statuses", () => {
  it("reports 127 for unknown commands and 126 for non-executables", async () => {
    const missing = await sh("nosuch arg");
    expect(missing.status).toBe(127);
    expect(missing.err).toBe("sh: command not found: nosuch\n");
    const exitCode = await sh("fail 4");
    expect(exitCode.status).toBe(4);
  });

  it("runs external commands with the environment and cwd", async () => {
    expect(await out("FOO=bar printenv FOO; printenv FOO; export FOO=baz; printenv FOO")).toBe(
      "bar\n\nbaz\n",
    );
    expect(await out("cd /tmp && pwdx && cd - >/dev/null && pwdx")).toBe("/tmp\n/work\n");
    expect(await out("A=1; printenv A; A=2 sh_var=1; export A; printenv A")).toBe("\n2\n");
  });

  it("follows && || ! and ;", async () => {
    expect(
      await out("true && echo a || echo b; false && echo c || echo d; ! false && echo e"),
    ).toBe("a\nd\ne\n");
  });

  it("supports set -e", async () => {
    const result = await sh("set -e; echo one; false; echo two");
    expect(result.status).toBe(1);
    expect(result.out).toBe("one\n");
    expect(
      await out(
        "set -e; false || true; if false; then :; fi; false && true; ! true; echo survived",
      ),
    ).toBe("survived\n");
    expect((await sh(["sh", "-ec", "fail 3; echo no"])).status).toBe(3);
  });

  it("supports set -u, set -x and pipefail", async () => {
    const unbound = await sh("set -u; echo $nope; echo after");
    expect(unbound.status).toBe(1);
    expect(unbound.err).toContain("nope: unbound variable");
    const traced = await sh("set -x; echo 'a b' c");
    expect(traced.err).toBe("+ echo 'a b' c\n");
    expect((await sh("fail 2 | true")).status).toBe(0);
    expect((await sh("set -o pipefail; fail 2 | true")).status).toBe(2);
  });

  it("runs exit and the EXIT trap", async () => {
    const result = await sh("trap 'echo bye' EXIT; echo hi; exit 5; echo no");
    expect(result.status).toBe(5);
    expect(result.out).toBe("hi\nbye\n");
  });
});

describe("pipelines", () => {
  it("pipes builtins into builtins", async () => {
    expect(await out("printf 'b\\na\\nc\\n' | sort | head -n 2")).toBe("a\nb\n");
    expect(await out("echo hello | tr a-z A-Z | wc -c")).toBe("6\n");
  });

  it("mixes builtins and external commands", async () => {
    expect(await out("echo hello | upper")).toBe("HELLO\n");
    expect(await out("echo hello | upper | tr H J")).toBe("JELLO\n");
    expect(await out("node a b | grep node | upper")).toBe("NODE A B\n");
  });

  it("feeds external output to builtins that read stdin", async () => {
    expect(
      await out('node a | cat; node b | while read w x; do echo "[$x]"; done; node c | wc -w'),
    ).toBe("node a\n[b]\n2\n");
  });

  it('drops "$@" with no arguments', async () => {
    expect(await out('set --; argv "$@" x; argv "${@}"')).toBe("<x>\n\n");
  });

  it("returns the last status and supports |&", async () => {
    expect((await sh("true | fail 7")).status).toBe(7);
    expect(await out("err to-stderr |& upper")).toBe("TO-STDERR\n");
  });

  it("runs pipeline stages in subshells", async () => {
    expect(await out('x=1; echo | x=2; echo $x; echo 5 | read y; echo "[$y]"')).toBe("1\n[]\n");
    expect(await out("printf 'a\\nb\\n' | while read line; do echo \"<$line>\"; done")).toBe(
      "<a>\n<b>\n",
    );
  });
});

describe("redirections", () => {
  it("writes, appends and reads files", async () => {
    const result = await sh(
      "echo one > f; echo two >> f; cat < f; cat f > g; echo three 1>>g; cat g",
    );
    expect(result.out).toBe("one\ntwo\none\ntwo\nthree\n");
    expect(readText(result.vfs, "/work/f")).toBe("one\ntwo\n");
  });

  it("duplicates and closes fds", async () => {
    const result = await sh(
      "err e1 2>&1 | upper; echo o >&2; echo x 2>/dev/null; err gone 2>/dev/null; err both &> all; cat all",
    );
    expect(result.out).toBe("E1\nx\nboth\n");
    expect(result.err).toBe("o\n");
    const closed = await sh("echo closed >&-; echo $?");
    expect(closed.out).toBe("1\n");
  });

  it("supports here-strings and heredocs", async () => {
    expect(
      await out(
        "name=World; cat <<EOF\nHello $name\n  $(echo sub)\nEOF\ncat <<'RAW'\n$name\nRAW\ncat <<-TABS\n\t\tindented\n\tTABS\nupper <<< \"$name\"",
      ),
    ).toBe("Hello World\n  sub\n$name\nindented\nWORLD\n");
  });

  it("reports missing files", async () => {
    const result = await sh("cat < nofile; echo $?");
    expect(result.err).toBe("sh: nofile: No such file or directory\n");
    expect(result.out).toBe("1\n");
  });

  it("redirects compound commands and exec", async () => {
    const result = await sh(
      "{ echo a; echo b; } > g; for i in 1 2; do echo $i; done >> g; exec 3> h; echo via3 >&3; cat g h",
    );
    expect(result.out).toBe("a\nb\n1\n2\nvia3\n");
  });

  it("reads lines from a redirected file in a loop", async () => {
    expect(
      await out('while IFS= read -r line; do echo "[$line]"; done < f', {
        files: { "/work/f": "  one\ntwo \\ x\nthree" },
      }),
    ).toBe("[  one]\n[two \\ x]\n");
  });
});

describe("control flow", () => {
  it("runs if/elif/else, case, loops, break and continue", async () => {
    const script = `
      for n in 1 2 3 4 5 6; do
        if [ $n -eq 2 ]; then continue; elif [ $n -ge 5 ]; then break; else echo "n=$n"; fi
      done
      i=0; while [ $i -lt 3 ]; do i=$((i+1)); done; echo i=$i
      until [ $i -eq 0 ]; do i=$((i-1)); done; echo i=$i
      for f in app.js style.css README; do
        case $f in
          *.js|*.ts) echo "$f: script";;
          *.css) echo "$f: style";;
          *) echo "$f: other";;
        esac
      done
      for ((k=0; k<2; k++)); do echo k=$k; done
      for a in 1 2; do for b in 1 2; do [ $b = 2 ] && continue 2; echo $a$b; done; done
    `;
    expect(await out(script)).toBe(
      "n=1\nn=3\nn=4\ni=3\ni=0\napp.js: script\nstyle.css: style\nREADME: other\nk=0\nk=1\n11\n21\n",
    );
  });

  it("evaluates [[ ]]", async () => {
    const files = { "/work/file": "x", "/work/empty": "" };
    const script = `
      [[ -f file && -d /tmp && ! -e nope ]] && echo files
      [[ -s file && ! -s empty ]] && echo sizes
      x=hello.js
      [[ $x == *.js ]] && echo glob
      [[ $x =~ ^h(el)+lo\\.js$ ]] && echo regex
      [[ 10 -gt 9 && abc < abd ]] && echo compare
      [[ -z "" && -n x ]] && echo strings
    `;
    expect(await out(script, { files })).toBe("files\nsizes\nglob\nregex\ncompare\nstrings\n");
  });

  it("defines functions with locals and return", async () => {
    const script = `
      greet() { local name=$1; echo "hi $name ($#)"; return 3; }
      name=outer
      greet bob x; echo "status=$? name=$name"
      function fact { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }
      fact 5
    `;
    expect(await out(script)).toBe("hi bob (2)\nstatus=3 name=outer\n120\n");
  });

  it("runs subshells and groups", async () => {
    expect(await out("x=1; (x=2; cd /tmp; echo $x $PWD); echo $x $PWD; { x=3; }; echo $x")).toBe(
      "2 /tmp\n1 /work\n3\n",
    );
    expect((await sh("(exit 4); echo $?")).out).toBe("4\n");
  });

  it("runs eval, source and aliases", async () => {
    const files = { "/work/lib.sh": 'libvar=loaded\nlibfn() { echo "fn $1"; }\n' };
    expect(
      await out(
        "eval 'a=1; echo $a'; . ./lib.sh; echo $libvar; libfn x; source lib.sh; alias say='echo said'; say it",
        { files },
      ),
    ).toBe("1\nloaded\nfn x\nsaid it\n");
  });

  it("supports background jobs and wait", async () => {
    const result = await sh("node bg & echo started; wait $!; echo status=$?");
    expect(result.out).toContain("started\n");
    expect(result.out).toContain("node bg\n");
    expect(result.out).toContain("status=0\n");
  });
});

describe("builtins", () => {
  it("cd, pwd, export, unset, readonly, shift, set --", async () => {
    const result = await sh(`
      cd /tmp; pwd; cd; pwd; cd /nope; echo $?
      export A=1; unset A; echo "[$A]"
      readonly R=1; R=2; echo $?
      set -- a b c; shift; echo "$@"; shift 2; echo $#
    `);
    expect(result.out).toBe("/tmp\n/home\n1\n[]\n1\nb c\n0\n");
    expect(result.err).toContain("cd: /nope: No such file or directory");
    expect(result.err).toContain("R: readonly variable");
  });

  it("read splits into variables", async () => {
    expect(
      await out('read a b <<< "one two three"; echo "$a|$b"; read -r x <<< "a\\\\b"; echo "$x"'),
    ).toBe("one|two three\na\\b\n");
    expect(await out("read line; echo got:$line", { stdin: "typed\n" })).toBe("got:typed\n");
  });

  it("type, which, command -v", async () => {
    const result = await sh(
      "type cd ls node nosuch; which node; command -v echo node; command -v nosuch; echo $?",
    );
    expect(result.out).toBe(
      "cd is a shell builtin\nls is a shell builtin\nnode is /bin/node\n/bin/node\necho\n/bin/node\n1\n",
    );
    expect(result.err).toContain("type: nosuch: not found");
  });

  it("printf and echo", async () => {
    expect(
      await out(
        "printf '%s-%d-%5.2f|%-4s|%03d|%x\\n' a 42 3.14159 ab 7 255; printf '%s\\n' x y; echo -n no; echo -e 'a\\tb'",
      ),
    ).toBe("a-42- 3.14|ab  |007|ff\nx\ny\nnoa\tb\n");
  });

  it("test and [", async () => {
    expect(
      await out(
        '[ "a" = "a" ] && echo eq; test 3 -lt 2 || echo lt; [ ! -f nope -a -d / ] && echo combo; [ -z "" ]; echo $?',
      ),
    ).toBe("eq\nlt\ncombo\n0\n");
  });

  it("env, kill and trap", async () => {
    expect(await out("env -i A=1 printenv A; env | grep '^HOME='")).toBe("1\nHOME=/home\n");
    expect((await sh("kill 99999")).status).toBe(1);
  });

  it("getopts parses options", async () => {
    const script =
      'while getopts "ab:" opt; do case $opt in a) echo A;; b) echo "B=$OPTARG";; esac; done; shift $((OPTIND-1)); echo "rest=$*"';
    expect(await out(["sh", "-c", script, "sh", "-a", "-b", "val", "file"])).toBe(
      "A\nB=val\nrest=file\n",
    );
  });
});

describe("invocation", () => {
  it("runs a script file with arguments", async () => {
    const files = { "/work/s.sh": '#!/bin/sh\necho "script $0 $1"\nexit 2\n' };
    const result = await sh(["sh", "s.sh", "arg"], { files });
    expect(result.out).toBe("script s.sh arg\n");
    expect(result.status).toBe(2);
    expect((await sh(["sh", "missing.sh"])).status).toBe(127);
  });

  it("reads the script from stdin", async () => {
    expect((await sh(["sh", "-s"], { stdin: "echo from stdin\n" })).out).toBe("from stdin\n");
    expect((await sh(["sh"], { stdin: "echo piped\n" })).out).toBe("piped\n");
  });

  it("says which syntax is not supported", async () => {
    for (const [script, message] of [
      ["a=(1 2)", "sh: a=(…): arrays are not supported\n"],
      ["echo ${a[0]}", "sh: ${a[…]}: arrays are not supported\n"],
      ["diff <(ls) x", "sh: process substitution <(…): not supported\n"],
      ["select x in a; do :; done", "sh: select: not supported\n"],
      ["trap 'echo' ERR", "sh: trap: ERR: not supported\n"],
    ]) {
      const result = await sh(script);
      expect(result.err).toBe(message);
      expect(result.status).not.toBe(0);
    }
    expect(await out('target=HOME; echo "${!target}"')).toBe("/home\n");
  });

  it("accepts -lc and reports syntax errors with status 2", async () => {
    expect((await sh(["sh", "-lc", "echo login"])).out).toBe("login\n");
    const bad = await sh("echo (");
    expect(bad.status).toBe(2);
    expect(bad.err).toContain("syntax error");
  });

  it("exits 130 on SIGINT and forwards it to the child", async () => {
    const { setupRuntime } = await import("./testHelpers");
    const { runShell } = await import("./index");
    const { rt } = setupRuntime({});
    rt.feedStdin(null);
    const done = runShell(["sh", "-c", "hang; echo after"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    rt.signal("SIGINT");
    expect(await done).toBe(130);
    expect(rt.stdout()).toBe("");
  });

  it("runs an INT trap and carries on", async () => {
    const { setupRuntime } = await import("./testHelpers");
    const { runShell } = await import("./index");
    const { rt } = setupRuntime({});
    rt.feedStdin(null);
    const done = runShell(["sh", "-c", "trap 'echo caught' INT; hang; echo after"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    rt.signal("SIGINT");
    expect(await done).toBe(0);
    expect(rt.stdout()).toBe("caught\nafter\n");
  });

  it("reports 126 when the kernel refuses to execute", async () => {
    const { setupRuntime } = await import("./testHelpers");
    const { runShell } = await import("./index");
    const { rt } = setupRuntime({});
    rt.feedStdin(null);
    rt.processes.spawn = (request) => {
      throw Object.assign(new Error("EACCES"), {
        code: "EACCES",
        errno: -13,
        syscall: `spawn ${request.command}`,
        path: request.command,
      });
    };
    expect(await runShell(["sh", "-c", "./script.sh"])).toBe(126);
    expect(rt.stderr()).toBe("sh: ./script.sh: Permission denied\n");
  });

  it("interrupts a builtin sleep on SIGTERM", async () => {
    const { setupRuntime } = await import("./testHelpers");
    const { runShell } = await import("./index");
    const { rt } = setupRuntime({});
    rt.feedStdin(null);
    const done = runShell(["sh", "-c", "sleep 10; echo after"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    rt.signal("SIGTERM");
    expect(await done).toBe(143);
  });
});
