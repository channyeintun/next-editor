// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SimpleCommand, Word } from "./ast";
import { ShellSyntaxError } from "./lexer";
import { parse } from "./parser";

function firstSimple(source: string): SimpleCommand {
  const command = parse(source).items[0].andOr.first.commands[0];
  if (command.type !== "simple") {
    throw new Error(`not simple: ${command.type}`);
  }
  return command;
}

function incomplete(source: string): boolean {
  try {
    parse(source);
    return false;
  } catch (error) {
    return error instanceof ShellSyntaxError && error.incomplete;
  }
}

describe("parser", () => {
  it("splits words and keeps quoting structure", () => {
    const command = firstSimple(`echo 'a b' "c $d" e\\ f $'x\\ty'`);
    expect(command.words).toHaveLength(5);
    expect(command.words[1]).toEqual<Word>({ parts: [{ type: "sq", value: "a b" }] });
    expect(command.words[2].parts[0]).toEqual({
      type: "dq",
      parts: [
        { type: "sq", value: "c " },
        { type: "param", name: "d" },
      ],
    });
    expect(command.words[3].parts).toEqual([
      { type: "lit", value: "e" },
      { type: "sq", value: " " },
      { type: "lit", value: "f" },
    ]);
    expect(command.words[4].parts).toEqual([{ type: "sq", value: "x\ty" }]);
  });

  it("recognizes assignments only before the command word", () => {
    const command = firstSimple("A=1 B+=2 cmd C=3");
    expect(command.assignments.map((a) => [a.name, a.append])).toEqual([
      ["A", false],
      ["B", true],
    ]);
    expect(command.words).toHaveLength(2);
  });

  it("parses lists, pipelines and and-or chains", () => {
    const program = parse("a | b |& c && d || e; f & g\n h");
    expect(program.items).toHaveLength(4);
    expect(program.items[0].andOr.first.commands).toHaveLength(3);
    expect(program.items[0].andOr.first.stderrToo).toEqual([false, true]);
    expect(program.items[0].andOr.rest.map((r) => r.op)).toEqual(["&&", "||"]);
    expect(program.items[1].background).toBe(true);
  });

  it("parses redirections with fds", () => {
    const command = firstSimple("cmd >out 2>&1 2>>log <in &>all 3>&- <<<str");
    expect(command.redirects.map((r) => [r.fd, r.op])).toEqual([
      [undefined, ">"],
      [2, ">&"],
      [2, ">>"],
      [undefined, "<"],
      [undefined, "&>"],
      [3, ">&"],
      [undefined, "<<<"],
    ]);
  });

  it("reads heredoc bodies after the line", () => {
    const program = parse("cat <<EOF; cat <<-'X'\nhello $name\nEOF\n\tliteral $x\n\tX\necho done");
    const first = program.items[0].andOr.first.commands[0] as SimpleCommand;
    const second = program.items[1].andOr.first.commands[0] as SimpleCommand;
    expect(first.redirects[0].heredoc?.quoted).toBe(false);
    expect(first.redirects[0].heredoc?.body.parts).toEqual([
      { type: "sq", value: "hello " },
      { type: "param", name: "name" },
      { type: "sq", value: "\n" },
    ]);
    expect(second.redirects[0].heredoc).toEqual({
      quoted: true,
      body: { parts: [{ type: "sq", value: "literal $x\n" }] },
    });
    expect(program.items).toHaveLength(3);
  });

  it("parses compound commands", () => {
    const program = parse(`
      if a; then b; elif c; then d; else e; fi
      for x in 1 2; do echo $x; done
      while false; do :; done
      until true; do :; done
      case $x in a|b) echo ab;; *) echo other;; esac
      f() { echo f; }
      function g { echo g; }
      ( cd /; ls )
      { a; b; } > out
      [[ -f x && $y == z* ]]
      (( i++ ))
      for ((i=0; i<3; i++)); do echo $i; done
    `);
    const types = program.items.map((item) => item.andOr.first.commands[0].type);
    expect(types).toEqual([
      "if",
      "for",
      "while",
      "while",
      "case",
      "function",
      "function",
      "subshell",
      "group",
      "cond",
      "arithcmd",
      "arithfor",
    ]);
  });

  it("parses command substitutions, nested", () => {
    const command = firstSimple('echo $(echo "$(echo hi)" `echo x`) after');
    expect(command.words).toHaveLength(3);
    expect(command.words[1].parts[0].type).toBe("cmdsub");
  });

  it("parses parameter operators", () => {
    const command = firstSimple('echo ${a:-x y} ${#b} ${c%%.*} ${d/a/b} ${e:1:2} "${f:?oops}"');
    const params = command.words.slice(1).map((word) => {
      const part = word.parts[0].type === "dq" ? word.parts[0].parts[0] : word.parts[0];
      return part.type === "param" ? [part.name, part.op ?? (part.length ? "#len" : "")] : null;
    });
    expect(params).toEqual([
      ["a", ":-"],
      ["b", "#len"],
      ["c", "%%"],
      ["d", "/"],
      ["e", ":"],
      ["f", ":?"],
    ]);
  });

  it("reports incomplete input", () => {
    expect(incomplete("echo 'abc")).toBe(true);
    expect(incomplete('echo "abc')).toBe(true);
    expect(incomplete("a &&")).toBe(true);
    expect(incomplete("a |")).toBe(true);
    expect(incomplete("if true; then")).toBe(true);
    expect(incomplete("echo \\")).toBe(true);
    expect(incomplete("cat <<EOF\nabc")).toBe(true);
    expect(incomplete("echo $(ls")).toBe(true);
    expect(incomplete("echo hi")).toBe(false);
    expect(incomplete("fi")).toBe(false);
  });

  it("rejects bad syntax", () => {
    expect(() => parse("echo ;;")).toThrow(ShellSyntaxError);
    expect(() => parse("| a")).toThrow(/unexpected token/);
  });

  it("handles comments and line continuation", () => {
    const program = parse("echo a \\\n  b # comment\n# whole line\necho c");
    expect(program.items).toHaveLength(2);
    expect((program.items[0].andOr.first.commands[0] as SimpleCommand).words).toHaveLength(3);
  });

  it("lexes =~ right side raw", () => {
    const program = parse("[[ $x =~ ^(a|b)[0-9]+$ ]]");
    const command = program.items[0].andOr.first.commands[0];
    expect(command.type).toBe("cond");
  });
});
