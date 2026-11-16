// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { readText, sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

const tree = {
  "/work/a.txt": "alpha\nbeta\ngamma\n",
  "/work/b.txt": "one\ntwo\n",
  "/work/src/index.js": "const x = 1;\nconsole.log(x);\n",
  "/work/src/util.ts": "export const y = 2;\n",
  "/work/.env": "SECRET=1\n",
};

async function run(
  script: string,
  files: Record<string, string> = tree,
): Promise<{ out: string; err: string; status: number }> {
  const result = await sh(script, { files });
  return { out: result.out, err: result.err, status: result.status };
}

describe("ls", () => {
  it("lists one per line when not a terminal, with -a -A -d -R", async () => {
    expect((await run("ls")).out).toBe("a.txt\nb.txt\nsrc\n");
    expect((await run("ls -A")).out).toBe(".env\na.txt\nb.txt\nsrc\n");
    expect((await run("ls -a src")).out).toBe(".\n..\nindex.js\nutil.ts\n");
    expect((await run("ls -d src")).out).toBe("src\n");
    expect((await run("ls -R src")).out).toBe("src:\nindex.js\nutil.ts\n");
    expect((await run("ls a.txt src")).out).toBe("a.txt\n\nsrc:\nindex.js\nutil.ts\n");
  });

  it("prints long and human-readable listings", async () => {
    const { out } = await run("ls -lh a.txt");
    expect(out).toMatch(/^-rw-r--r-- 1 user user 17 \w{3} [ \d]\d (\d\d:\d\d| \d{4}) a\.txt\n$/);
  });

  it("columns on a terminal", async () => {
    const result = await sh("ls", { files: tree, tty: true });
    expect(result.out).toBe("a.txt  b.txt  \x1b[1;34msrc\x1b[0m\n");
  });

  it("reports missing files", async () => {
    const result = await run("ls nope");
    expect(result.status).toBe(2);
    expect(result.err).toBe("ls: cannot access 'nope': No such file or directory\n");
  });
});

describe("file commands", () => {
  it("cat, cat -n", async () => {
    expect((await run("cat a.txt b.txt")).out).toBe("alpha\nbeta\ngamma\none\ntwo\n");
    expect((await run("cat -n b.txt")).out).toBe("     1\tone\n     2\ttwo\n");
    expect((await run("cat nope")).err).toBe("cat: nope: No such file or directory\n");
  });

  it("mkdir -p, rmdir, rm -r -f, touch", async () => {
    const result = await sh(
      "mkdir -p x/y/z && touch x/y/z/f && rm x/y/z/f && rmdir x/y/z && ls x/y; rm -rf x; ls; rm nope; rm -f nope; echo $?",
      {
        files: tree,
      },
    );
    expect(result.out).toBe("a.txt\nb.txt\nsrc\n0\n");
    expect(result.err).toBe("rm: cannot remove 'nope': No such file or directory\n");
    expect((await run("mkdir src")).err).toBe(
      "mkdir: cannot create directory 'src': File exists\n",
    );
    expect((await run("rm src")).err).toBe("rm: cannot remove 'src': Is a directory\n");
  });

  it("cp, cp -r, mv, ln -s, readlink, realpath", async () => {
    const result = await sh(
      "cp a.txt c.txt && cp -r src lib && mv b.txt src/ && ln -s a.txt link && readlink link && realpath link && ls . src lib && cat c.txt link | wc -l",
      {
        files: tree,
      },
    );
    expect(result.out).toBe(
      "a.txt\n/work/a.txt\n.:\na.txt\nc.txt\nlib\nlink\nsrc\n\nlib:\nindex.js\nutil.ts\n\nsrc:\nb.txt\nindex.js\nutil.ts\n6\n",
    );
    expect((await run("cp src dest")).err).toBe("cp: -r not specified; omitting directory 'src'\n");
  });

  it("chmod octal and symbolic", async () => {
    const result = await sh(
      "chmod 600 a.txt; ls -l a.txt | cut -c1-10; chmod u+x,g+r a.txt; ls -l a.txt | cut -c1-10; chmod a-r a.txt; ls -l a.txt | cut -c1-10",
      { files: tree },
    );
    expect(result.out).toBe("-rw-------\n-rwxr-----\n--wx------\n");
  });

  it("find with -name -type -maxdepth -not -o", async () => {
    expect((await run("find src")).out).toBe("src\nsrc/index.js\nsrc/util.ts\n");
    expect((await run("find . -name '*.js'")).out).toBe("./src/index.js\n");
    expect((await run("find . -type d")).out).toBe(".\n./src\n");
    expect((await run("find . -maxdepth 1 -type f -not -name '.*'")).out).toBe(
      "./a.txt\n./b.txt\n",
    );
    expect((await run("find src -name '*.js' -o -name '*.ts'")).out).toBe(
      "src/index.js\nsrc/util.ts\n",
    );
    expect((await run("find . -name src -prune -o -type f -print")).out).toBe(
      "./.env\n./a.txt\n./b.txt\n",
    );
    expect((await run("find src -name '*.ts' -exec cat {} \\;")).out).toBe("export const y = 2;\n");
  });

  it("basename, dirname", async () => {
    expect(
      (
        await run(
          "basename /a/b/c.js .js; basename /a/b/; dirname /a/b/c.js; dirname c.js; dirname /",
        )
      ).out,
    ).toBe("c\nb\n/a/b\n.\n/\n");
  });
});

describe("text commands", () => {
  it("head and tail", async () => {
    const files = { "/work/n": "1\n2\n3\n4\n5\n" };
    expect(
      (
        await run(
          "head -n 2 n; head -2 n; head -c 3 n; echo; tail -n 2 n; tail -n +4 n; tail -1 n",
          files,
        )
      ).out,
    ).toBe("1\n2\n1\n2\n1\n2\n4\n5\n4\n5\n5\n");
    expect((await run("head -n 1 n n", files)).out).toBe("==> n <==\n1\n\n==> n <==\n1\n");
    expect((await run("seq 10 | head -n 3")).out).toBe("1\n2\n3\n");
    expect((await run("tail -f n", files)).err).toBe("tail: -f: not supported\n");
  });

  it("wc", async () => {
    expect((await run("wc a.txt")).out).toBe(" 3  3 17 a.txt\n");
    expect((await run("wc -l a.txt b.txt")).out).toBe("3 a.txt\n2 b.txt\n5 total\n");
    expect((await run("cat a.txt | wc -l")).out).toBe("3\n");
    expect((await run("printf 'a b\\nc' | wc -w")).out).toBe("3\n");
  });

  it("grep options", async () => {
    expect((await run("grep -n a a.txt")).out).toBe("1:alpha\n2:beta\n3:gamma\n");
    expect((await run("grep -c m a.txt; grep -v a a.txt; echo $?")).out).toBe("1\n1\n");
    expect((await run("grep -i ALPHA a.txt; grep -w one b.txt; grep -o 'a.' a.txt")).out).toBe(
      "alpha\none\nal\nam\n",
    );
    expect((await run("grep -rl const src | sort")).out).toBe("src/index.js\nsrc/util.ts\n");
    expect((await run("grep -r 'x\\b' src")).out).toBe(
      "src/index.js:const x = 1;\nsrc/index.js:console.log(x);\n",
    );
    expect(
      (await run("grep -E 'al|ga' a.txt; grep 'b\\(e\\)ta' a.txt; grep -F '.' a.txt; echo $?")).out,
    ).toBe("alpha\ngamma\nbeta\n1\n");
    expect(
      (await run("grep -q beta a.txt && echo found; grep -x beta a.txt; grep -e one -e two b.txt"))
        .out,
    ).toBe("found\nbeta\none\ntwo\n");
    const missing = await run("grep x nope");
    expect(missing.status).toBe(2);
  });

  it("sort and uniq", async () => {
    const files = { "/work/s": "b\na\nc\na\n10\n9\n" };
    expect((await run("sort s", files)).out).toBe("10\n9\na\na\nb\nc\n");
    expect((await run("sort -r -u s", files)).out).toBe("c\nb\na\n9\n10\n");
    expect((await run("sort -n s | tail -2", files)).out).toBe("9\n10\n");
    expect((await run("sort s | uniq -c", files)).out).toBe(
      "      1 10\n      1 9\n      2 a\n      1 b\n      1 c\n",
    );
    expect((await run("printf 'x 2\\ny 1\\n' | sort -k2 -n")).out).toBe("y 1\nx 2\n");
  });

  it("tr and cut", async () => {
    expect(
      (
        await run(
          "echo hello | tr a-z A-Z; echo hello | tr -d l; echo 'a  b' | tr -s ' '; echo abc | tr '[:lower:]' '[:upper:]'",
        )
      ).out,
    ).toBe("HELLO\nheo\na b\nABC\n");
    expect(
      (await run("echo a:b:c:d | cut -d: -f2,4; echo a:b:c | cut -d: -f2-; echo hello | cut -c2-4"))
        .out,
    ).toBe("b:d\nb:c\nell\n");
  });

  it("sed", async () => {
    expect((await run("sed 's/a/A/' a.txt; sed -n '2p' a.txt; sed 's/a/A/g;2d' a.txt")).out).toBe(
      "Alpha\nbetA\ngAmma\nbeta\nAlphA\ngAmmA\n",
    );
    expect(
      (
        await run(
          "echo hello world | sed -E 's/(\\w+) (\\w+)/\\2 \\1/'; echo path/to/x | sed 's|/|-|g'; echo abc | sed 's/b/[&]/'",
        )
      ).out,
    ).toBe("world hello\npath-to-x\na[b]c\n");
    expect(
      (
        await run(
          "sed -n '/beta/,/gamma/p' a.txt; sed '$d' b.txt; sed -e 's/one/1/' -e 's/two/2/' b.txt",
        )
      ).out,
    ).toBe("beta\ngamma\none\n1\n2\n");
    const inPlace = await sh("sed -i 's/one/ONE/' b.txt; cat b.txt", { files: tree });
    expect(inPlace.out).toBe("ONE\ntwo\n");
    expect(readText(inPlace.vfs, "/work/b.txt")).toBe("ONE\ntwo\n");
  });

  it("tee, xargs, seq", async () => {
    const result = await sh(
      "echo hi | tee t1 | upper; cat t1; echo more | tee -a t1 >/dev/null; cat t1",
      { files: tree },
    );
    expect(result.out).toBe("HI\nhi\nhi\nmore\n");
    expect(
      (
        await run(
          "printf 'a\\nb c\\n' | xargs echo X; echo 1 2 3 | xargs -n 1 echo; printf 'f1\\nf2\\n' | xargs -I{} echo [{}]",
        )
      ).out,
    ).toBe("X a b c\n1\n2\n3\n[f1]\n[f2]\n");
    expect((await run("seq 3; seq 2 4; seq 1 2 7; seq -s, 3")).out).toBe(
      "1\n2\n3\n2\n3\n4\n1\n3\n5\n7\n1,2,3\n",
    );
  });
});

describe("system commands", () => {
  it("whoami, hostname, uname, date", async () => {
    expect((await run("whoami; hostname; uname; uname -m; uname -a")).out).toBe(
      "user\nlocalhost\nLinux\nx86_64\nLinux localhost 5.0.0-webnode #1 SMP x86_64 GNU/Linux\n",
    );
    expect((await run("date -u -d @0 '+%Y-%m-%d %H:%M:%S %a %b %j %s'")).out).toBe(
      "1970-01-01 00:00:00 Thu Jan 001 0\n",
    );
    expect((await run("date -u -d @86400")).out).toBe("Fri Jan  2 00:00:00 UTC 1970\n");
  });

  it("says ps is not available", async () => {
    const result = await run("ps");
    expect(result.status).toBe(1);
    expect(result.err).toContain("ps: not available");
  });
});

describe("curl", () => {
  it("talks HTTP to a local port", async () => {
    const { setupRuntime } = await import("../testHelpers");
    const { runShell } = await import("../index");
    const { rt } = setupRuntime({});
    rt.feedStdin(null);
    const decoder = new TextDecoder();
    const server = rt.net.listen(3000, "127.0.0.1", (channel) => {
      let request = "";
      channel.onData = (chunk) => {
        request += decoder.decode(chunk);
        if (request.includes("\r\n\r\n")) {
          const [line] = request.split("\r\n");
          const body = `you sent ${line}`;
          channel.write(
            new TextEncoder().encode(
              `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
            ),
          );
          channel.end();
        }
      };
    });
    const status = await runShell([
      "sh",
      "-c",
      "curl -s localhost:3000/hello?x=1; echo; curl -sI http://127.0.0.1:3000/ | head -1; curl -s localhost:3001; echo $?",
    ]);
    server.close();
    expect(status).toBe(0);
    expect(rt.stdout()).toBe("you sent GET /hello?x=1 HTTP/1.1\nHTTP/1.1 200 OK\r\n7\n");
  });
});
