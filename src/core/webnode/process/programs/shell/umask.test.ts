// @vitest-environment node
// The shell's file mode creation mask: the `umask` builtin's forms and words
// (what bash 3.2 answers and prints), what the shell's redirections and
// built-in commands create under a mask (modes as bash and GNU coreutils
// leave them), and that a subshell, a pipeline stage and a background job
// each keep a mask of their own inside the one process.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import type { SpawnRequest } from "../../runtime";
import type { FakeChildIo } from "../../testing/fakeRuntime";
import { runShell } from "./index";
import { defaultExternal, setupRuntime, sh } from "./testHelpers";
import { formatSymbolicUmask, formatUmask, parseUmask } from "./umask";

afterEach(() => {
  setRuntime(null);
});

/** `name mode` for each of `names` under /work, the mode as four octal digits. */
function modes(vfs: { stat(path: string, follow: boolean): { mode: number } }, names: string[]) {
  return names.map(
    (name) =>
      `${name} ${(vfs.stat(`/work/${name}`, false).mode & 0o7777).toString(8).padStart(4, "0")}`,
  );
}

describe("the operand of umask", () => {
  const set = (text: string, current = 0o022) => {
    const parsed = parseUmask(text, current);
    return "mask" in parsed ? formatUmask(parsed.mask) : parsed.error;
  };

  it("takes an octal number of any length up to 0777", () => {
    expect(["077", "27", "0", "0000", "777", "0027", "00027"].map((text) => set(text))).toEqual([
      "0077",
      "0027",
      "0000",
      "0000",
      "0777",
      "0027",
      "0027",
    ]);
    expect(["999", "1000", "7777", "08", "0x12", "1a", "22 "].map((text) => set(text))).toEqual([
      "999: octal number out of range",
      "1000: octal number out of range",
      "7777: octal number out of range",
      "08: octal number out of range",
      "0x12: octal number out of range",
      "1a: octal number out of range",
      "22 : octal number out of range",
    ]);
  });

  it("applies symbolic clauses to the permissions the mask allows", () => {
    const cases: [text: string, current: number, mask: string][] = [
      ["u=rwx,g=rx,o=", 0o022, "0027"],
      ["g-w,o-rwx", 0o022, "0027"],
      ["a=rx", 0o022, "0222"],
      ["u+w,g+w,o+w", 0o022, "0000"],
      ["go=", 0o022, "0077"],
      ["=rw", 0o022, "0111"],
      ["+x", 0o022, "0022"],
      ["+r", 0o077, "0033"],
      ["a+rwx", 0o077, "0000"],
      ["u-x", 0o022, "0122"],
      ["ug=rwx,o=rx", 0o022, "0002"],
      ["a-x", 0o022, "0133"],
      ["u=rwx,go+w", 0o022, "0000"],
      ["g=", 0o022, "0072"],
      ["u=", 0o022, "0722"],
      ["=", 0o022, "0777"],
      ["a=", 0o022, "0777"],
      ["u+rwx,g-rwx,o=r", 0o022, "0073"],
      ["u=r,u+w", 0o022, "0122"],
      ["ugo=r", 0o022, "0333"],
      ["u=rr", 0o022, "0322"],
      ["uu=r", 0o022, "0322"],
      ["+", 0o022, "0022"],
      ["u+", 0o022, "0022"],
      ["-", 0o022, "0022"],
    ];
    expect(cases.map(([text, current]) => set(text, current))).toEqual(
      cases.map(([, , mask]) => mask),
    );
  });

  it("names the character it could not take, as bash does", () => {
    const operator = (shown: string) => `\`${shown}': invalid symbolic mode operator`;
    const character = (shown: string) => `\`${shown}': invalid symbolic mode character`;
    const cases: [text: string, error: string][] = [
      ["z=r", operator("z")],
      ["u%r", operator("%")],
      ["rwx", operator("r")],
      ["abc", operator("b")],
      [" 22", operator(" ")],
      [",", operator(",")],
      [",u=rw", operator(",")],
      // Where the text ends bash prints the NUL it found there.
      ["u", operator("\0")],
      ["a", operator("\0")],
      ["", operator("\0")],
      ["u=rw,", operator("\0")],
      ["u=rw,z", operator("z")],
      ["u=q", character("q")],
      ["g=u", character("u")],
      ["o+X", character("X")],
      ["o+s", character("s")],
      ["o+t", character("t")],
      ["u+r-w", character("-")],
      ["u=r=w", character("=")],
      ["-S", character("S")],
    ];
    expect(cases.map(([text]) => set(text))).toEqual(cases.map(([, error]) => error));
  });

  it("prints a mask as four octal digits, and as the permissions it allows", () => {
    expect([0o022, 0, 0o777, 0o7].map(formatUmask)).toEqual(["0022", "0000", "0777", "0007"]);
    expect([0o022, 0o077, 0o027, 0o777, 0, 0o351].map(formatSymbolicUmask)).toEqual([
      "u=rwx,g=rx,o=rx",
      "u=rwx,g=,o=",
      "u=rwx,g=rx,o=",
      "u=,g=,o=",
      "u=rwx,g=rwx,o=rwx",
      "u=r,g=w,o=rw",
    ]);
  });
});

describe("the umask builtin", () => {
  it("prints the mask as bash does, with -S and -p", async () => {
    const result = await sh("umask; umask -S; umask -p; umask -p -S; umask -pS; umask -Sp");
    expect(result.out).toBe(
      "0022\nu=rwx,g=rx,o=rx\numask 0022\numask -S u=rwx,g=rx,o=rx\n" +
        "umask -S u=rwx,g=rx,o=rx\numask -S u=rwx,g=rx,o=rx\n",
    );
    expect(result.status).toBe(0);
  });

  it("sets the mask from an octal number or a symbolic mode, and prints it only with -S", async () => {
    const result = await sh(
      "umask 077; echo s=$?; umask; umask -S; umask u=rwx,g=rx,o=; umask; " +
        "umask -S 027; umask; umask -p 022; umask; umask -S u=rwx,g=,o=; umask; " +
        "umask 022 077; umask; umask -- 027; umask; umask -S -- 022",
    );
    expect(result.out).toBe(
      "s=0\n0077\nu=rwx,g=,o=\n0027\n" +
        "u=rwx,g=rx,o=\n0027\n0022\nu=rwx,g=,o=\n0077\n" +
        "0022\n0027\nu=rwx,g=rx,o=rx\n",
    );
    expect(result.err).toBe("");
  });

  it("refuses a bad mask with status 1, a bad option with status 2, and keeps the mask", async () => {
    const result = await sh(
      "umask 999; echo s=$?; umask z=r; echo s=$?; umask u=q; echo s=$?; umask -x; echo s=$?; " +
        "umask -r; echo s=$?; umask -- -S; echo s=$?; umask",
    );
    expect(result.out).toBe("s=1\ns=1\ns=1\ns=2\ns=2\ns=1\n0022\n");
    expect(result.err).toBe(
      "sh: umask: 999: octal number out of range\n" +
        "sh: umask: `z': invalid symbolic mode operator\n" +
        "sh: umask: `q': invalid symbolic mode character\n" +
        "sh: umask: -x: invalid option\numask: usage: umask [-p] [-S] [mode]\n" +
        "sh: umask: -r: invalid option\numask: usage: umask [-p] [-S] [mode]\n" +
        "sh: umask: `S': invalid symbolic mode character\n",
    );
  });

  it("starts with the process's mask, and in the main shell sets the process's", async () => {
    const { rt } = setupRuntime();
    rt.umask = 0o027;
    rt.feedStdin(null);
    expect(await runShell(["sh", "-c", "umask; : > made; umask 077; (umask 002); umask"])).toBe(0);
    expect(rt.stdout()).toBe("0027\n0077\n");
    expect(rt.umask).toBe(0o077);
    expect(modes(rt.vfs, ["made"])).toEqual(["made 0640"]);
  });
});

describe("what the shell creates under a mask", () => {
  // bash 3.2 and GNU coreutils under `umask 077`: every file -rw-------, every
  // directory drwx------; `mkdir -m` sets its operand exactly and leaves the
  // parents `-p` makes to the mask. Run in the main shell, whose mask is the
  // process's, and in a subshell, whose mask is its own.
  it.each([
    ["the main shell", (commands: string) => `umask 077; ${commands}`],
    ["a subshell", (commands: string) => `(umask 077; ${commands})`],
  ])("masks redirections and what the built-in commands make, in %s", async (_where, under) => {
    const result = await sh(
      under(
        "echo hi > r1; : >> r2; mkdir d1; mkdir -p p1/p2; touch t1; cp r1 c1; " +
          "echo x | tee te1 > /dev/null; echo b | sort -o so1; exec 3> fd3; exec 3>&-; " +
          "mkdir -m 755 dm; mkdir -p -m 711 pm/pn; sed -i s/h/j/ r1; cat r1",
      ),
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("ji\n");
    expect(
      modes(result.vfs, [
        "r1",
        "r2",
        "d1",
        "p1",
        "p1/p2",
        "t1",
        "c1",
        "te1",
        "so1",
        "fd3",
        "dm",
        "pm",
        "pm/pn",
      ]),
    ).toEqual([
      "r1 0600",
      "r2 0600",
      "d1 0700",
      "p1 0700",
      "p1/p2 0700",
      "t1 0600",
      "c1 0600",
      "te1 0600",
      "so1 0600",
      "fd3 0600",
      "dm 0755",
      "pm 0700",
      "pm/pn 0711",
    ]);
  });

  // GNU sed -i writes a new file beside the original (0600 less the mask),
  // gives it the original's mode and renames it over the original; a mask
  // that takes the owner's write off the new file changes nothing in the end.
  it("leaves a file sed -i rewrites with its own mode, whatever the mask", async () => {
    const result = await sh(
      "echo hi > a; chmod 664 a; echo hi > b; chmod 600 b; " +
        "(umask 077; sed -i s/h/j/ a); (umask 277; sed -i s/h/j/ b); cat a b; ls",
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("ji\nji\na\nb\n");
    expect(modes(result.vfs, ["a", "b"])).toEqual(["a 0664", "b 0600"]);
  });

  // GNU cp: a new file gets the source's permission bits less the mask, a
  // copied directory the same; -p gives both the source's own modes.
  it("cuts what cp makes by the mask, and not what cp -p makes", async () => {
    const result = await sh(
      ": > s777; chmod 777 s777; mkdir sd777; chmod 777 sd777; : > sd777/f; chmod 666 sd777/f; " +
        "(umask 077; cp s777 u777; cp -p s777 up777; cp -r sd777 ud777; cp -rp sd777 udp777); " +
        "(umask 027; cp s777 v777; cp -r sd777 vd777); (umask 0; cp s777 w777; : > w0; mkdir wd0)",
    );
    expect(result.err).toBe("");
    expect(
      modes(result.vfs, [
        "u777",
        "up777",
        "ud777",
        "ud777/f",
        "udp777",
        "udp777/f",
        "v777",
        "vd777",
        "vd777/f",
        "w777",
        "w0",
        "wd0",
      ]),
    ).toEqual([
      "u777 0700",
      "up777 0777",
      "ud777 0700",
      "ud777/f 0600",
      "udp777 0777",
      "udp777/f 0666",
      "v777 0750",
      "vd777 0750",
      "vd777/f 0640",
      "w777 0777",
      "w0 0666",
      "wd0 0777",
    ]);
  });

  // GNU cp 9.x: -p gives a directory, new or already there, its source's
  // mode; without it a new one is the source's less the mask and one already
  // there keeps its own. A source its owner may not write is copied whole.
  it("gives a copied directory the mode GNU cp gives it", async () => {
    const result = await sh(
      "mkdir s; : > s/f; chmod 666 s/f; mkdir s/in; chmod 777 s s/in; " +
        "cp -r s n; cp -rp s np; mkdir -m 700 e; cp -rpT s e; mkdir -m 700 e2; cp -rT s e2; " +
        "mkdir ro; : > ro/f; mkdir ro/in; : > ro/in/g; chmod 555 ro ro/in; " +
        "cp -r ro nro; echo s=$?; cp -rp ro npro; echo s=$?; (umask 077; cp -r ro uro)",
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("s=0\ns=0\n");
    expect(
      modes(result.vfs, [
        "n",
        "n/f",
        "n/in",
        "np",
        "np/f",
        "np/in",
        "e",
        "e/f",
        "e2",
        "e2/f",
        "nro",
        "nro/f",
        "nro/in",
        "nro/in/g",
        "npro",
        "npro/in",
        "uro",
        "uro/in",
      ]),
    ).toEqual([
      "n 0755",
      "n/f 0644",
      "n/in 0755",
      "np 0777",
      "np/f 0666",
      "np/in 0777",
      "e 0777",
      "e/f 0666",
      "e2 0700",
      "e2/f 0644",
      "nro 0555",
      "nro/f 0644",
      "nro/in 0555",
      "nro/in/g 0644",
      "npro 0555",
      "npro/in 0555",
      "uro 0500",
      "uro/in 0500",
    ]);
  });

  // GNU mkdir -p and cp -r under masks that take the owner's own bits off
  // (277, 777): the directories on the way keep the owner's write and search
  // so the next can be made, and a copied directory is opened up while its
  // entries are written. Only the last directory is left as the mask has it.
  it("still makes a tree under a mask that takes the owner's bits", async () => {
    const result = await sh(
      "mkdir s; : > s/f; chmod 666 s/f; mkdir s/in; chmod 777 s s/in; " +
        "(umask 277; mkdir -p m1/m2/m3; echo s=$?; mkdir m4; mkdir -p -m 777 m5/m6; : > of; " +
        "cp -r s o; echo s=$?; cp -rp s op; echo s=$?); " +
        "(umask 777; mkdir -p k1/k2; echo s=$?; : > z1; mkdir zd; cp -r s z; echo s=$?); " +
        "(umask 177; mkdir od; mkdir -m 700 odm)",
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("s=0\ns=0\ns=0\ns=0\ns=0\n");
    expect(
      modes(result.vfs, [
        "m1",
        "m1/m2",
        "m1/m2/m3",
        "m4",
        "m5",
        "m5/m6",
        "of",
        "o",
        "op",
        "k1",
        "z1",
        "zd",
        "z",
        "od",
        "odm",
      ]),
    ).toEqual([
      "m1 0700",
      "m1/m2 0700",
      "m1/m2/m3 0500",
      "m4 0500",
      "m5 0700",
      "m5/m6 0777",
      "of 0400",
      "o 0500",
      "op 0777",
      "k1 0300",
      "z1 0000",
      "zd 0000",
      "z 0000",
      "od 0600",
      "odm 0700",
    ]);
    // What is inside, seen as the page sees it: the modes hide nothing from it.
    const inside = (path: string) =>
      result.vfs.privileged.stat(`/work/${path}`, false).mode & 0o7777;
    expect(["o/f", "o/in", "op/f", "op/in", "k1/k2", "z/f", "z/in"].map(inside)).toEqual([
      0o400, 0o500, 0o666, 0o777, 0, 0, 0,
    ]);
  });

  it("leaves links, renames and existing files alone", async () => {
    const result = await sh(
      "echo a > f; mkdir d; umask 077; ln f hard; ln -s f soft; echo b > f; mv f moved; " +
        "touch moved d; chmod 664 d",
    );
    expect(result.err).toBe("");
    expect(modes(result.vfs, ["hard", "soft", "moved", "d"])).toEqual([
      "hard 0644",
      "soft 0777",
      "moved 0644",
      "d 0664",
    ]);
  });
});

describe("a mask of its own for each shell in the process", () => {
  // bash 3.2, each line: the subshell prints 0077 and the shell after it 0022.
  it("keeps a subshell's mask inside it", async () => {
    const result = await sh(
      "(umask 077; echo hi > s1; mkdir sd1; umask); umask; echo hi > s2; " +
        "umask 077 | cat; umask; x=$(umask 027; umask; : > cs1); echo $x; umask",
    );
    expect(result.out).toBe("0077\n0022\n0022\n0027\n0022\n");
    expect(modes(result.vfs, ["s1", "sd1", "s2", "cs1"])).toEqual([
      "s1 0600",
      "sd1 0700",
      "s2 0644",
      "cs1 0640",
    ]);
    expect(result.rt.umask).toBe(0o022);
  });

  it("sets the shell's own mask in a brace group and in a function", async () => {
    const result = await sh("{ umask 077; }; umask; f() { umask 027; }; f; umask; : > made");
    expect(result.out).toBe("0077\n0027\n");
    expect(modes(result.vfs, ["made"])).toEqual(["made 0640"]);
  });

  it("gives a subshell the mask of the shell it leaves at that moment", async () => {
    const result = await sh(
      "umask 027; (umask; : > a; (umask 077; : > b); : > c); " +
        "echo x | (cat > pl); : > bg & wait; (umask 077; : > p1) | (: > p2; cat)",
    );
    expect(result.out).toBe("0027\n");
    expect(modes(result.vfs, ["a", "b", "c", "pl", "bg", "p1", "p2"])).toEqual([
      "a 0640",
      "b 0600",
      "c 0640",
      "pl 0640",
      "bg 0640",
      "p1 0600",
      "p2 0640",
    ]);
  });

  it("keeps the masks of shells that run at the same time apart", async () => {
    // The background subshells wait while the main shell goes on under
    // another mask, and it changes its mask while they run.
    const result = await sh(
      "(umask 077; sleep 0.05; mkdir late; echo x | sort -o sorted) & " +
        "umask 002; mkdir early; (sleep 0.02; : > copy) & umask 027; : > after; wait; mkdir end; umask",
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("0027\n");
    expect(modes(result.vfs, ["late", "sorted", "early", "copy", "after", "end"])).toEqual([
      "late 0700",
      "sorted 0600",
      "early 0775",
      "copy 0664",
      "after 0640",
      "end 0750",
    ]);
    // The process's mask is the main shell's again, whatever a subshell made last.
    expect(result.rt.umask).toBe(0o027);
  });

  it("starts each program under the mask of the shell that runs it", async () => {
    const spawn = (request: SpawnRequest, io: FakeChildIo) => {
      if (request.command !== "node") {
        return defaultExternal(request, io);
      }
      io.writeStdout(`${request.args.join(" ")} ${request.umask?.toString(8)}\n`);
      return 0;
    };
    const result = await sh(
      "node main; umask 027; node set; (umask 077; node sub); node after; " +
        "(umask 002; node bg) & wait; node last | cat",
      { spawn },
    );
    expect(result.out).toBe("main 22\nset 27\nsub 77\nafter 27\nbg 2\nlast 27\n");
  });
});
