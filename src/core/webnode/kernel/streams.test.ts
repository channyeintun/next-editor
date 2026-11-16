// @vitest-environment node
// Pipes and terminals: buffering, end of stream, the foreground reader, raw
// mode across attach/detach, and waiters that do not pile up.
import { describe, expect, it } from "vitest";
import { Pipe, Terminal } from "./streams";

const decoder = new TextDecoder();

function waiterCount(terminal: Terminal): number {
  return (terminal as unknown as { waiters: Map<number, Set<() => void>> }).waiters.size;
}

function makeTerminal(interrupts: number[] = []): Terminal {
  return new Terminal(
    { cols: 80, rows: 24 },
    () => {},
    (pid) => interrupts.push(pid),
  );
}

describe("Pipe", () => {
  it("delivers what was written, then null once every writer is gone", () => {
    const pipe = new Pipe();
    pipe.addReader();
    pipe.addWriter();
    let woken = 0;
    pipe.whenReadable(0, () => {
      woken += 1;
    });
    pipe.write(new TextEncoder().encode("abc"));
    expect(woken).toBe(1);
    expect(decoder.decode(pipe.take(2)!)).toBe("ab");
    expect(decoder.decode(pipe.take(10)!)).toBe("c");
    expect(pipe.take(10)).toBeUndefined();
    pipe.removeWriter();
    expect(pipe.take(10)).toBeNull();
  });

  it("has no readers once the last read end closes", () => {
    const pipe = new Pipe();
    pipe.addReader();
    pipe.addWriter();
    expect(pipe.hasReaders).toBe(true);
    pipe.removeReader();
    expect(pipe.hasReaders).toBe(false);
  });
});

describe("Terminal", () => {
  it("keeps raw mode when a new reader attaches", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.raw = true;
    terminal.attach(2);
    expect(terminal.raw).toBe(true);
    terminal.detach(2);
    expect(terminal.raw).toBe(true);
  });

  it("gives input to the foreground reader only", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    terminal.input("hi\r");
    expect(terminal.take(100, 1)).toBeUndefined();
    expect(decoder.decode(terminal.take(100, 2)!)).toBe("hi\n");
  });

  it("interrupts the foreground reader on Ctrl+C", () => {
    const interrupts: number[] = [];
    const terminal = makeTerminal(interrupts);
    terminal.attach(1);
    terminal.attach(2);
    terminal.input("\x03");
    expect(interrupts).toEqual([2]);
  });

  it("drops a reader's waiters when it detaches and after they run", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    terminal.whenReadable(2, () => {});
    terminal.whenReadable(1, () => {});
    expect(waiterCount(terminal)).toBe(2);
    terminal.detach(2);
    // Reader 1 is the foreground again and was woken: nothing is left waiting.
    expect(waiterCount(terminal)).toBe(0);
    for (let pid = 10; pid < 20; pid += 1) {
      terminal.attach(pid);
      terminal.whenReadable(pid, () => {});
      terminal.detach(pid);
    }
    expect(waiterCount(terminal)).toBe(0);
  });

  it("does not loop when a woken callback waits again", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    let calls = 0;
    const wait = () => {
      calls += 1;
      if (terminal.take(100, 1) === undefined) {
        terminal.whenReadable(1, wait);
      }
    };
    terminal.attach(2);
    terminal.whenReadable(1, wait);
    // Reader 2 leaving wakes reader 1, which finds nothing and waits again.
    terminal.detach(2);
    expect(calls).toBe(1);
    terminal.input("x\r");
    expect(calls).toBe(2);
  });
});
