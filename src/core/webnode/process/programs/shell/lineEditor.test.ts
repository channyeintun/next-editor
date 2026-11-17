// @vitest-environment node
import { describe, expect, it } from "vitest";
import { History, LineEditor, charWidth, displayWidth } from "./lineEditor";
import type { EditResult } from "./lineEditor";

function editor(options: { columns?: number; candidates?: string[]; history?: string[] } = {}) {
  let output = "";
  const history = new History();
  for (const line of options.history ?? []) {
    history.add(line);
  }
  const instance = new LineEditor(
    {
      write: (text) => {
        output += text;
      },
      columns: () => options.columns ?? 80,
      complete: (line, cursor) => {
        let start = cursor;
        while (start > 0 && line[start - 1] !== " ") {
          start--;
        }
        const word = line.slice(start, cursor);
        return { start, candidates: (options.candidates ?? []).filter((c) => c.startsWith(word)) };
      },
    },
    history,
  );
  return {
    instance,
    output: () => output,
    clear: () => {
      output = "";
    },
  };
}

async function type(
  keys: string,
  options: Parameters<typeof editor>[0] = {},
): Promise<{ result: EditResult; output: string }> {
  const { instance, output } = editor(options);
  const promise = instance.readLine("$ ");
  instance.feedText(keys);
  return { result: await promise, output: output() };
}

describe("LineEditor", () => {
  it("inserts text and submits on Enter", async () => {
    const { result, output } = await type("echo hi\r");
    expect(result).toEqual({ type: "line", text: "echo hi" });
    expect(output.startsWith("$ ")).toBe(true);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("moves the cursor and edits in the middle", async () => {
    expect((await type("ac\x1b[Db\r")).result).toEqual({ type: "line", text: "abc" });
    expect((await type("abc\x01X\x05Y\r")).result).toEqual({ type: "line", text: "XabcY" });
    expect((await type("abcd\x1b[D\x1b[D\x7f\r")).result).toEqual({ type: "line", text: "acd" });
    expect((await type("abcd\x1b[D\x1b[D\x1b[3~\r")).result).toEqual({ type: "line", text: "abd" });
    expect((await type("abc\x1b[H\x1b[C\x1b[CZ\x1b[F!\r")).result).toEqual({
      type: "line",
      text: "abZc!",
    });
  });

  it("moves and deletes by word", async () => {
    expect((await type("one two three\x1b[1;5D\x1b[1;5DX\r")).result).toEqual({
      type: "line",
      text: "one Xtwo three",
    });
    expect((await type("one two three\x1bb\x1bb\x1bfY\r")).result).toEqual({
      type: "line",
      text: "one twoY three",
    });
    expect((await type("one two three\x17\r")).result).toEqual({ type: "line", text: "one two " });
    expect((await type("one two\x01\x1bd\r")).result).toEqual({ type: "line", text: " two" });
  });

  it("kills to the start and end", async () => {
    expect((await type("hello world\x1b[D\x1b[D\x15\r")).result).toEqual({
      type: "line",
      text: "ld",
    });
    expect((await type("hello world\x01\x1b[C\x0b\r")).result).toEqual({ type: "line", text: "h" });
  });

  it("decodes UTF-8 split across chunks", async () => {
    const { instance } = editor();
    const promise = instance.readLine("$ ");
    const bytes = new TextEncoder().encode("héllo ❯\r");
    instance.feed(bytes.subarray(0, 2));
    instance.feed(bytes.subarray(2, 9));
    instance.feed(bytes.subarray(9));
    expect(await promise).toEqual({ type: "line", text: "héllo ❯" });
  });

  it("handles escape sequences split across chunks", async () => {
    const { instance } = editor();
    const promise = instance.readLine("$ ");
    instance.feedText("ab\x1b");
    instance.feedText("[D");
    instance.feedText("X\r");
    expect(await promise).toEqual({ type: "line", text: "aXb" });
  });

  it("reports Ctrl+C and Ctrl+D", async () => {
    const interrupted = await type("partial\x03");
    expect(interrupted.result).toEqual({ type: "interrupt" });
    expect(interrupted.output).toContain("^C\n");
    expect((await type("\x04")).result).toEqual({ type: "eof" });
    expect((await type("ab\x01\x04\r")).result).toEqual({ type: "line", text: "b" });
  });

  it("walks history with up and down, keeping the draft", async () => {
    const history = ["first", "second"];
    expect((await type("\x1b[A\r", { history })).result).toEqual({ type: "line", text: "second" });
    expect((await type("\x1b[A\x1b[A\r", { history })).result).toEqual({
      type: "line",
      text: "first",
    });
    expect((await type("draft\x1b[A\x1b[B\r", { history })).result).toEqual({
      type: "line",
      text: "draft",
    });
    expect((await type("\x10\x10\x0e\r", { history })).result).toEqual({
      type: "line",
      text: "second",
    });
  });

  it("completes the common prefix and lists on a second Tab", async () => {
    expect((await type("ec\t\r", { candidates: ["echo"] })).result).toEqual({
      type: "line",
      text: "echo ",
    });
    expect((await type("cat sr\t\r", { candidates: ["src/"] })).result).toEqual({
      type: "line",
      text: "cat src/",
    });
    expect((await type("g\t\r", { candidates: ["grep", "greet"] })).result).toEqual({
      type: "line",
      text: "gre",
    });
    const listed = await type("gre\t\t\r", { candidates: ["grep", "greet"] });
    expect(listed.output).toContain("\ngrep   greet\n\r$ gre");
    expect(listed.result).toEqual({ type: "line", text: "gre" });
  });

  it("inserts bracketed paste literally and splits it at newlines", async () => {
    const { instance } = editor();
    const first = instance.readLine("$ ");
    instance.feedText("\x1b[200~echo a\x03b\necho c\x1b[201~");
    expect(await first).toEqual({ type: "line", text: "echo ab" });
    const second = instance.readLine("$ ");
    instance.feedText("\r");
    expect(await second).toEqual({ type: "line", text: "echo c" });
  });

  it("queues keys typed while no line is being read", async () => {
    const { instance } = editor();
    instance.feedText("early\r");
    expect(await instance.readLine("$ ")).toEqual({ type: "line", text: "early" });
  });

  it("redraws simple edits in place", async () => {
    const { instance, output, clear } = editor();
    const promise = instance.readLine("$ ");
    clear();
    instance.feedText("a");
    expect(output()).toBe("\r$ a\x1b[J\r\x1b[3C");
    clear();
    instance.feedText("\x1b[D");
    expect(output()).toBe("\r$ a\x1b[J\r\x1b[2C");
    instance.feedText("\r");
    await promise;
  });

  it("wraps lines wider than the terminal", async () => {
    const { instance, output, clear } = editor({ columns: 10 });
    const promise = instance.readLine("$ ");
    instance.feedText("12345678");
    clear();
    // Prompt (2) + 8 characters fill the row exactly: the cursor moves to the next row.
    instance.feedText("\x1b[D");
    expect(output()).toBe("\x1b[1A\r$ 12345678\x1b[J\n\x1b[1A\r\x1b[9C");
    clear();
    instance.feedText("\x1b[F9");
    // Now on the second row: go up one row before redrawing.
    expect(output()).toContain("\x1b[1A\r$ 123456789\x1b[J");
    expect(output().endsWith("\r\x1b[1C")).toBe(true);
    instance.feedText("\r");
    expect(await promise).toEqual({ type: "line", text: "123456789" });
  });

  it("measures wide characters and ignores ANSI codes in width", () => {
    expect(displayWidth("\x1b[1;34m~/app\x1b[0m ❯ ")).toBe(8);
    expect(displayWidth("日本")).toBe(4);
  });

  it("keeps history free of blanks and repeats", () => {
    const history = new History(2);
    expect(history.add("a")).toBe(true);
    expect(history.add("a")).toBe(false);
    expect(history.add("  ")).toBe(false);
    history.add("b");
    history.add("c");
    expect(history.entries).toEqual(["b", "c"]);
  });
});

describe("charWidth (shell-11)", () => {
  it("matches xterm's default (Unicode 6) widths, which the shell terminal keeps", () => {
    // xterm gives emoji outside its wide ranges one cell, so the cursor does too.
    for (const text of ["🚀", "😀", "🤖", "✅", "❌", "🪄", "a"]) {
      expect(charWidth(text.codePointAt(0) as number)).toBe(1);
    }
    for (const text of ["中", "가", "〈", "Ａ", "𠀀"]) {
      expect(charWidth(text.codePointAt(0) as number)).toBe(2);
    }
    expect(charWidth(0x303f)).toBe(1);
  });
});
