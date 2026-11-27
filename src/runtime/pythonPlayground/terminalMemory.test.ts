// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PLAYGROUND_INPUT_LINE_MAX_LENGTH } from "../playgroundLanguage";
import { PYTHON_MAX_OUTPUT_BYTES } from "./interpreter";
import { openPythonTerminal, programPythonTerminal } from "./terminalMemory";

/**
 * Both ends of the terminal on one thread. The program's `readLine` parks its
 * thread on `Atomics.wait`, which here would park the test, so the wait is
 * replaced by what happens during a real one: the page answering. That the
 * two ends meet across a real worker is checked in the browser.
 */
function terminal() {
  const link = openPythonTerminal();
  if (!link) throw new Error("this host has no shared memory");
  return { page: link.view, program: programPythonTerminal(link.memory) };
}

const bytes = (text: string) => new TextEncoder().encode(text);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Python terminal's shared memory", () => {
  it("shows the page what the program wrote, as far as it has written", () => {
    const { page, program } = terminal();

    expect(page.output()).toBe("");
    program.write?.(bytes("Name: "));
    expect(page.output()).toBe("Name: ");
    program.write?.(bytes("Chan\nHello"));
    expect(page.output()).toBe("Name: Chan\nHello");
  });

  it("joins a character whose bytes arrive in two writes", () => {
    const { page, program } = terminal();
    const [head, ...tail] = bytes("ဆ");

    program.write?.(new Uint8Array([head]));
    expect(page.output()).toBe("");
    program.write?.(new Uint8Array(tail));
    expect(page.output()).toBe("ဆ");
  });

  it("never writes past the output it has room for", () => {
    const { page, program } = terminal();

    program.write?.(new Uint8Array(PYTHON_MAX_OUTPUT_BYTES - 1).fill(97));
    program.write?.(bytes("bcd"));

    const output = page.output();
    expect(output).toHaveLength(PYTHON_MAX_OUTPUT_BYTES);
    expect(output.endsWith("ab")).toBe(true);
  });

  it("parks the program until the page answers, then hands it the line", () => {
    const { page, program } = terminal();
    const waits: boolean[] = [];
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      waits.push(page.isWaiting());
      page.answer("ဆယ် ten");
      return "ok";
    });

    expect(page.isWaiting()).toBe(false);
    expect(program.readLine?.()).toBe("ဆယ် ten");
    expect(waits).toEqual([true]);
    expect(page.isWaiting()).toBe(false);
  });

  it("waits again when woken with no answer", () => {
    const { page, program } = terminal();
    let wakes = 0;
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      wakes += 1;
      if (wakes === 3) page.answer("");
      return "ok";
    });

    expect(program.readLine?.()).toBe("");
    expect(wakes).toBe(3);
  });

  it("tells a line from the end of the input", () => {
    const { page, program } = terminal();
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      page.answer(null);
      return "ok";
    });

    expect(program.readLine?.()).toBeNull();
  });

  it("takes the longest line the dock lets a learner type, in any script", () => {
    const { page, program } = terminal();
    const line = "ဆ".repeat(PLAYGROUND_INPUT_LINE_MAX_LENGTH);
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      page.answer(line);
      return "ok";
    });

    expect(program.readLine?.()).toBe(line);
  });

  it("cuts a longer line at a whole character", () => {
    const { page, program } = terminal();
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      page.answer("ဆ".repeat(PLAYGROUND_INPUT_LINE_MAX_LENGTH + 5));
      return "ok";
    });

    expect(program.readLine?.()).toBe("ဆ".repeat(PLAYGROUND_INPUT_LINE_MAX_LENGTH));
  });

  it("is not there on a page that cannot share memory with a worker", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    expect(openPythonTerminal()).toBeNull();
  });
});
