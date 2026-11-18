// @vitest-environment node
// Pipes and terminals: buffering, end of stream, the foreground reader, raw
// mode across attach/detach, and waiters that do not pile up.
import { describe, expect, it } from "vitest";
import { Delivery, PIPE_BUF, PIPE_CAPACITY, Pipe, Terminal, TerminalDelivery } from "./streams";

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

  it("gives a read several writes at once, up to what it asked for, as read(2) does", () => {
    const pipe = new Pipe();
    pipe.addReader();
    pipe.addWriter();
    for (const line of ["one\n", "two\n", "three\n"]) {
      pipe.write(new TextEncoder().encode(line));
    }
    // A reader that asks for a buffer's worth is not answered a line at a time.
    expect(decoder.decode(pipe.take(10)!)).toBe("one\ntwo\nth");
    expect(pipe.size).toBe(4);
    expect(decoder.decode(pipe.take(100)!)).toBe("ree\n");
    expect(pipe.take(100)).toBeUndefined();
    // Exactly what fits whole, and a first write larger than the read alone.
    pipe.write(new TextEncoder().encode("ab"));
    pipe.write(new TextEncoder().encode("cd"));
    pipe.write(new TextEncoder().encode("ef"));
    expect(decoder.decode(pipe.take(4)!)).toBe("abcd");
    expect(decoder.decode(pipe.take(1)!)).toBe("e");
    expect(decoder.decode(pipe.take(1)!)).toBe("f");
    expect(pipe.size).toBe(0);
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

describe("Pipe capacity", () => {
  function openPipe(): Pipe {
    const pipe = new Pipe();
    pipe.addReader();
    pipe.addWriter();
    return pipe;
  }

  it("holds 64 KiB, and a write that does not fit waits for the reader", () => {
    const pipe = openPipe();
    expect(PIPE_CAPACITY).toBe(65536);
    const data = new Uint8Array(70000).fill(7);
    expect(pipe.tryWrite(data)).toBe(65536);
    expect(pipe.size).toBe(65536);
    const settled: [number, boolean][] = [];
    pipe.write(data.subarray(65536), (written, broken) => settled.push([written, broken]));
    expect(settled).toEqual([]);
    expect(pipe.waitingBytes).toBe(4464);
    // Taking bytes makes room; the waiting write goes in and is done.
    expect(pipe.take(10000)!.byteLength).toBe(10000);
    expect(settled).toEqual([[4464, false]]);
    expect(pipe.size).toBe(60000);
  });

  it("puts a write of at most PIPE_BUF bytes in whole or not at all", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY - 100));
    expect(pipe.tryWrite(new Uint8Array(PIPE_BUF))).toBe(0);
    // A larger write takes what fits.
    expect(pipe.tryWrite(new Uint8Array(PIPE_BUF + 1))).toBe(100);
  });

  it("lets no write in ahead of one that waits", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY));
    const order: string[] = [];
    pipe.write(new Uint8Array(10).fill(1), () => order.push("first"));
    expect(pipe.tryWrite(new Uint8Array(1))).toBe(0);
    pipe.write(new Uint8Array(10).fill(2), () => order.push("second"));
    pipe.take(PIPE_CAPACITY);
    expect(order).toEqual(["first", "second"]);
    const bytes = pipe.deliver(100)!;
    expect([...bytes]).toEqual([...new Uint8Array(10).fill(1), ...new Uint8Array(10).fill(2)]);
  });

  it("lets no write in ahead of one that waits for room the later one would fit in", () => {
    // One process's own writes: a 4096-byte line that must go in whole waits
    // for room, and the short line after it must not overtake it.
    const pipe = openPipe();
    expect(pipe.tryWrite(new Uint8Array(PIPE_CAPACITY - 100))).toBe(PIPE_CAPACITY - 100);
    const order: string[] = [];
    pipe.write(new Uint8Array(PIPE_BUF).fill(1), () => order.push("long"));
    // There is room for these 10 bytes, but not their turn.
    expect(pipe.tryWrite(new Uint8Array(10).fill(2))).toBe(0);
    pipe.write(new Uint8Array(10).fill(2), () => order.push("short"));
    expect(order).toEqual([]);
    expect(pipe.take(PIPE_CAPACITY)!.byteLength).toBe(PIPE_CAPACITY - 100);
    expect(order).toEqual(["long", "short"]);
    // In the order they were written: the long line whole, then the short one.
    expect([...pipe.take(PIPE_CAPACITY)!]).toEqual([
      ...new Uint8Array(PIPE_BUF).fill(1),
      ...new Uint8Array(10).fill(2),
    ]);
    // With nothing waiting, a write that fits goes in at once.
    expect(pipe.tryWrite(new Uint8Array(10))).toBe(10);
  });

  it("counts what it delivers to a reading process until that is acknowledged", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY));
    let done = false;
    pipe.write(new Uint8Array(1000), () => {
      done = true;
    });
    expect(pipe.deliver(PIPE_CAPACITY)!.byteLength).toBe(PIPE_CAPACITY);
    // Sent, but not yet handed to the reader: the room is still taken.
    expect(pipe.size).toBe(PIPE_CAPACITY);
    expect(done).toBe(false);
    pipe.acknowledge(500);
    expect(done).toBe(false);
    pipe.acknowledge(500);
    expect(done).toBe(true);
    expect(pipe.size).toBe(PIPE_CAPACITY);
    // An acknowledgement beyond what was sent frees nothing more.
    pipe.acknowledge(1 << 20);
    expect(pipe.size).toBe(1000);
  });

  it("merges small writes into one delivery", () => {
    const pipe = openPipe();
    for (let index = 0; index < 5; index += 1) {
      pipe.tryWrite(new TextEncoder().encode(`line ${index}\n`));
    }
    expect(decoder.decode(pipe.deliver(PIPE_CAPACITY)!)).toBe(
      "line 0\nline 1\nline 2\nline 3\nline 4\n",
    );
    expect(pipe.deliver(PIPE_CAPACITY)).toBeUndefined();
  });

  it("puts back bytes a reading process never received, ahead of the rest", () => {
    const pipe = openPipe();
    pipe.tryWrite(new TextEncoder().encode("first "));
    const sent = pipe.deliver(PIPE_CAPACITY)!;
    pipe.tryWrite(new TextEncoder().encode("second"));
    let woken = 0;
    pipe.whenReadable(0, () => (woken += 1));
    pipe.unread([sent], sent.byteLength);
    expect(woken).toBe(1);
    expect(pipe.size).toBe(12);
    expect(decoder.decode(pipe.deliver(PIPE_CAPACITY)!)).toBe("first second");
  });

  it("frees the room of put-back bytes that had stopped counting only once they are read", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY));
    const sent = pipe.deliver(PIPE_CAPACITY)!;
    // They stopped counting (their reader waited in a call): the pipe has room again.
    pipe.acknowledge(sent.byteLength);
    expect(pipe.tryWrite(new Uint8Array(10))).toBe(10);
    pipe.unread([sent], 0);
    expect(pipe.size).toBe(PIPE_CAPACITY + 10);
    expect(pipe.tryWrite(new Uint8Array(1))).toBe(0);
  });

  it("drops put-back bytes once no reader is left", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(100));
    const sent = pipe.deliver(PIPE_CAPACITY)!;
    pipe.removeReader();
    pipe.unread([sent], sent.byteLength);
    expect(pipe.size).toBe(0);
  });

  it("fails the waiting writes when the last reader goes, saying how much went in", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY - 10_000));
    const settled: [number, boolean][] = [];
    pipe.write(new Uint8Array(30_000), (written, broken) => settled.push([written, broken]));
    pipe.write(new Uint8Array(10), (written, broken) => settled.push([written, broken]));
    pipe.removeReader();
    expect(settled).toEqual([
      [10_000, true],
      [0, true],
    ]);
    expect(pipe.size).toBe(0);
  });

  it("ends the stream only after the writes still waiting are in", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY));
    pipe.write(new Uint8Array(100).fill(9));
    pipe.removeWriter();
    expect(pipe.take(PIPE_CAPACITY)!.byteLength).toBe(PIPE_CAPACITY);
    expect([...pipe.take(PIPE_CAPACITY)!]).toEqual([...new Uint8Array(100).fill(9)]);
    expect(pipe.take(PIPE_CAPACITY)).toBeNull();
  });

  it("keeps what a withdrawn write put in, and lets the next one go", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY - 100));
    const withdraw = pipe.write(new Uint8Array(10_000).fill(1));
    let next = false;
    pipe.write(new Uint8Array(50).fill(2), () => {
      next = true;
    });
    withdraw();
    // The 100 bytes that fitted stay; the next write now goes in.
    expect(next).toBe(false);
    pipe.take(PIPE_CAPACITY - 100);
    expect(next).toBe(true);
    expect([...pipe.deliver(1000)!]).toEqual([
      ...new Uint8Array(100).fill(1),
      ...new Uint8Array(50).fill(2),
    ]);
  });

  it("wakes a reader waiting for the end when the last waiting write is withdrawn", () => {
    const pipe = openPipe();
    pipe.tryWrite(new Uint8Array(PIPE_CAPACITY));
    pipe.deliver(PIPE_CAPACITY);
    const withdraw = pipe.write(new Uint8Array(10));
    pipe.removeWriter();
    let woken = 0;
    pipe.whenReadable(0, () => {
      woken += 1;
    });
    expect(pipe.take(10)).toBeUndefined();
    withdraw();
    expect(woken).toBe(1);
    expect(pipe.take(10)).toBeNull();
  });
});

describe("Delivery", () => {
  function sending(bytes: number[]) {
    const pipe = new Pipe();
    pipe.addReader();
    pipe.addWriter();
    const delivery = new Delivery(pipe);
    for (const length of bytes) {
      pipe.tryWrite(new Uint8Array(length).fill(length & 0xff));
      delivery.sent(pipe.deliver(PIPE_CAPACITY)!);
    }
    return { pipe, delivery };
  }

  it("frees the room of what the worker says it received, oldest first", () => {
    const { pipe, delivery } = sending([100, 200]);
    expect(pipe.size).toBe(300);
    expect(delivery.received(100)).toBe(false);
    expect(pipe.size).toBe(200);
    delivery.received(200);
    expect([pipe.size, delivery.empty]).toEqual([0, true]);
  });

  it("frees the room at once when the worker waits, and says when it has caught up", () => {
    const { pipe, delivery } = sending([100, 200]);
    delivery.hold();
    expect([pipe.size, delivery.held]).toEqual([0, true]);
    expect(delivery.received(100)).toBe(false);
    expect(delivery.received(200)).toBe(true);
    expect([pipe.size, delivery.held]).toEqual([0, false]);
  });

  it("puts back what never arrived, and only that", () => {
    const { pipe, delivery } = sending([100, 200]);
    delivery.received(100);
    delivery.putBack();
    expect(pipe.size).toBe(200);
    expect([...pipe.take(PIPE_CAPACITY)!]).toEqual([...new Uint8Array(200).fill(200)]);
  });

  it("puts back what had stopped counting without taking another reader's bytes off the count", () => {
    // Two workers stream the same pipe. One waits in a blocking call, so what
    // was on its way stopped counting; then it ends, and those bytes go back.
    const { pipe, delivery } = sending([100, 200]);
    const other = new Delivery(pipe);
    pipe.tryWrite(new Uint8Array(50).fill(50));
    other.sent(pipe.deliver(PIPE_CAPACITY)!);
    expect(pipe.size).toBe(350);
    delivery.hold();
    expect(pipe.size).toBe(50);
    delivery.putBack();
    // Back in the pipe: the 300 buffered again, and the 50 still on their way to the other.
    expect(pipe.size).toBe(350);
    expect([delivery.empty, delivery.held]).toEqual([true, false]);
    other.received(50);
    expect(pipe.size).toBe(300);
    // The two that were put back, in their order.
    expect([...pipe.take(PIPE_CAPACITY)!]).toEqual([
      ...new Uint8Array(100).fill(100),
      ...new Uint8Array(200).fill(200),
    ]);
  });

  it("counts again, on the next delivery, bytes put back after a hold", () => {
    const { pipe, delivery } = sending([1000]);
    delivery.hold();
    delivery.putBack();
    const again = new Delivery(pipe);
    again.sent(pipe.deliver(PIPE_CAPACITY)!);
    // On their way again and counted: a full pipe's writer waits for them.
    expect(pipe.tryWrite(new Uint8Array(PIPE_CAPACITY))).toBe(PIPE_CAPACITY - 1000);
    expect(pipe.size).toBe(PIPE_CAPACITY);
    again.received(1000);
    expect(pipe.size).toBe(PIPE_CAPACITY - 1000);
  });
});

describe("Terminal", () => {
  it("keeps raw mode when a new reader attaches", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.attach(2);
    expect(terminal.raw).toBe(true);
    terminal.detach(2);
    expect(terminal.raw).toBe(true);
  });

  it("gives input to the newest reader that is waiting to read", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    const got: [number, string][] = [];
    const reader = (pid: number) => () => {
      got.push([pid, decoder.decode(terminal.take(100, pid)!)]);
    };
    terminal.whenReadable(1, reader(1));
    terminal.whenReadable(2, reader(2));
    terminal.input("hi\r");
    expect(got).toEqual([[2, "hi\n"]]);
  });

  it("does not let a reader that never reads hold up an older one that does", () => {
    // A watch supervisor reads its terminal; the program it started never does.
    const terminal = makeTerminal();
    terminal.attach(1);
    const woken: number[] = [];
    terminal.whenReadable(1, () => woken.push(1));
    terminal.attach(2);
    terminal.input("\r");
    expect(woken).toEqual([1]);
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("\n");
    // A background process still waits.
    terminal.input("x\r");
    expect(terminal.take(100, 3)).toBeUndefined();
  });

  it("goes back to the mode a process found once that process leaves the foreground", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    terminal.setRaw(true, 2);
    // A process that never changed the mode puts nothing back.
    terminal.detach(1);
    expect(terminal.raw).toBe(true);
    terminal.detach(2);
    expect(terminal.raw).toBe(false);
    // Only once: it has no say afterwards.
    terminal.setRaw(true, 3);
    terminal.detach(2);
    expect(terminal.raw).toBe(true);
  });

  it("keeps a parent's raw mode when a child that also set it leaves, or turns it off", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    terminal.setRaw(true, 1);
    // The child found the terminal raw: its end puts that back.
    terminal.setRaw(true, 2);
    terminal.detach(2);
    expect(terminal.raw).toBe(true);
    // And so does turning raw mode off again.
    terminal.setRaw(true, 3);
    terminal.setRaw(false, 3);
    expect(terminal.raw).toBe(true);
    terminal.detach(3);
    expect(terminal.raw).toBe(true);
    terminal.setRaw(false, 1);
    expect(terminal.raw).toBe(false);
  });

  it("changes nothing for a process that asks for the mode it already has", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    terminal.setRaw(true, 1);
    // Process 2 never turned raw mode on: turning it off is not its to do.
    terminal.setRaw(false, 2);
    expect(terminal.raw).toBe(true);
    terminal.detach(2);
    expect(terminal.raw).toBe(true);
    // Process 1 has raw mode on by its own account, whatever the terminal is now.
    terminal.setRaw(true, 3);
    terminal.setRaw(false, 1);
    expect(terminal.raw).toBe(false);
    terminal.setRaw(false, 1);
    terminal.setRaw(true, 3);
    expect(terminal.raw).toBe(false);
  });

  it("interrupts the foreground reader on Ctrl+C", () => {
    const interrupts: number[] = [];
    const terminal = makeTerminal(interrupts);
    terminal.attach(1);
    terminal.attach(2);
    terminal.input("\x03");
    expect(interrupts).toEqual([2]);
  });

  it("keeps readers in the order their processes started, each once", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(5);
    // Process 3 started before 5 and joins later (it opened /dev/tty).
    terminal.attach(3);
    terminal.attach(5);
    expect(terminal.foreground).toBe(5);
    terminal.detach(5);
    expect(terminal.foreground).toBe(3);
    terminal.detach(3);
    expect(terminal.foreground).toBe(1);
  });

  it("keeps no waiter once it has run or was withdrawn", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    const stopWaiting = terminal.whenReadable(2, () => {});
    terminal.whenReadable(1, () => {});
    expect(waiterCount(terminal)).toBe(2);
    terminal.detach(2);
    // Reader 1 is the foreground again and was woken. Reader 2 still waits,
    // as a background reader does, until its process gives the wait up.
    expect(waiterCount(terminal)).toBe(1);
    stopWaiting();
    expect(waiterCount(terminal)).toBe(0);
    for (let pid = 10; pid < 20; pid += 1) {
      terminal.attach(pid);
      const stop = terminal.whenReadable(pid, () => {});
      terminal.detach(pid);
      stop();
    }
    expect(waiterCount(terminal)).toBe(0);
  });

  it("gives input to an older reader once a newer one has stopped waiting", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    const got: [number, string][] = [];
    terminal.whenReadable(1, () => got.push([1, decoder.decode(terminal.take(100, 1)!)]));
    // The newer reader waits, then gives the wait up (its process is blocked in a call).
    const stopWaiting = terminal.whenReadable(2, () => got.push([2, "woken"]));
    stopWaiting();
    terminal.input("hi\r");
    expect(got).toEqual([[1, "hi\n"]]);
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

describe("TerminalDelivery", () => {
  function echoing(): { terminal: Terminal; shown: () => string } {
    let shown = "";
    const terminal = new Terminal(
      { cols: 80, rows: 24 },
      (text) => {
        shown += text;
      },
      () => {},
    );
    return { terminal, shown: () => shown };
  }

  /** A reader takes everything typed so far, as a pump does, and is sent it. */
  function send(terminal: Terminal, delivery: TerminalDelivery): void {
    for (let chunk = terminal.take(100, 1); chunk; chunk = terminal.take(100, 1)) {
      delivery.sent(chunk);
    }
  }

  it("puts back what the worker never handed to its reader, in order and as it was", () => {
    const { terminal, shown } = echoing();
    terminal.attach(1);
    const delivery = new TerminalDelivery(terminal);
    terminal.input("one\rtwo\rthree\r");
    send(terminal, delivery);
    expect(terminal.take(100, 1)).toBeUndefined();
    delivery.received(4);
    expect(delivery.empty).toBe(false);
    const echoed = shown();
    delivery.putBack();
    expect(delivery.empty).toBe(true);
    // The lines were edited and echoed once: they are not echoed again.
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("two\n");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("three\n");
    expect(shown()).toBe(echoed);
    // Nothing is left to put back.
    delivery.putBack();
    expect(terminal.take(100, 1)).toBeUndefined();
  });

  it("puts nothing back once the worker has handed everything over", () => {
    const { terminal } = echoing();
    terminal.attach(1);
    const delivery = new TerminalDelivery(terminal);
    terminal.input("one\rtwo\r");
    send(terminal, delivery);
    delivery.received(4);
    delivery.received(4);
    expect(delivery.empty).toBe(true);
    delivery.putBack();
    expect(terminal.take(100, 1)).toBeUndefined();
  });

  it("puts back nothing that was sent before a Ctrl+C flushed the input", () => {
    const { terminal } = echoing();
    terminal.attach(1);
    const delivery = new TerminalDelivery(terminal);
    terminal.input("before\r");
    send(terminal, delivery);
    terminal.input("\x03after\r");
    send(terminal, delivery);
    delivery.putBack();
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("after\n");
    expect(terminal.take(100, 1)).toBeUndefined();
  });

  it("puts keys taken in raw mode back as typed: a cooked reader gets them edited and echoed", () => {
    const { terminal, shown } = echoing();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    const delivery = new TerminalDelivery(terminal);
    terminal.input("lx\x7fs\r");
    send(terminal, delivery);
    terminal.setRaw(false, 1);
    delivery.putBack();
    expect(shown()).toBe("");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ls\n");
    expect(shown()).toBe("lx\b \bs\r\n");
  });
});

describe("Terminal: readers that leave and keys typed ahead", () => {
  const encoder = new TextEncoder();

  function echoing(): { terminal: Terminal; shown: () => string; interrupts: number[] } {
    let shown = "";
    const interrupts: number[] = [];
    const terminal = new Terminal(
      { cols: 80, rows: 24 },
      (text) => {
        shown += text;
      },
      (pid) => interrupts.push(pid),
    );
    return { terminal, shown: () => shown, interrupts };
  }

  it("takes only the reader that leaves out of the foreground", () => {
    const terminal = makeTerminal();
    // A shell (1) runs a program (2) that starts two children on the terminal: 3, then 4.
    for (const pid of [1, 2, 3, 4]) {
      terminal.attach(pid);
    }
    let got = "";
    const read = () => {
      const chunk = terminal.take(100, 4);
      if (chunk) {
        got += decoder.decode(chunk);
      }
      terminal.whenReadable(4, read);
    };
    read();
    // The first child ends; the second is still running and still reading.
    terminal.detach(3);
    expect(terminal.foreground).toBe(4);
    terminal.input("hello\r");
    expect(got).toBe("hello\n");
    expect(terminal.take(100, 1)).toBeUndefined();
  });

  it("makes a detached reader wait, like a background one, and gives its input to the reader before it", () => {
    const terminal = makeTerminal();
    // A shell (1) runs a supervisor (2), whose child (3) reads on after the kernel took it out.
    terminal.attach(1);
    terminal.attach(2);
    terminal.attach(3);
    terminal.detach(2);
    terminal.detach(3);
    expect(terminal.foreground).toBe(1);
    let woken = 0;
    terminal.whenReadable(3, () => {
      woken += 1;
    });
    terminal.input("ls\r");
    expect(woken).toBe(0);
    expect(terminal.take(100, 3)).toBeUndefined();
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ls\n");
    // The next command the shell runs gets the terminal as usual.
    terminal.attach(4);
    terminal.input("x\r");
    expect(decoder.decode(terminal.take(100, 4)!)).toBe("x\n");
  });

  it("gives keys a reader did not use to the next reader, edited as cooked input", () => {
    const { terminal, shown } = echoing();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.input("cat\rline one\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("cat\rline one\r");
    // The shell's line editor used `cat\r` and gives the rest back.
    terminal.unread(encoder.encode("line one\r"));
    terminal.setRaw(false, 1);
    expect(shown()).toBe("");
    terminal.attach(2);
    expect(decoder.decode(terminal.take(100, 2)!)).toBe("line one\n");
    expect(shown()).toBe("line one\r\n");
  });

  it("leaves keys typed ahead as typed when the next reader is raw again", () => {
    const { terminal, shown } = echoing();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.input("ls\r");
    terminal.setRaw(false, 1);
    terminal.setRaw(true, 1);
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ls\r");
    expect(shown()).toBe("");
  });

  it("keeps keys typed ahead before keys typed later, and given-back keys first", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.input("b");
    terminal.unread(encoder.encode("a"));
    terminal.setRaw(false, 1);
    terminal.input("c\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("abc\n");
  });

  it("keeps given-back keys before an unfinished line typed since", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.input("ls\rone\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ls\rone\r");
    terminal.setRaw(false, 1);
    // A key arrives before the shell has given back what followed its command line.
    terminal.input("x");
    terminal.unread(encoder.encode("one\r"));
    terminal.input("y\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("one\n");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("xy\n");
  });

  it("gives a raw reader the line that was being typed when raw mode came on", () => {
    const { terminal, shown } = echoing();
    terminal.attach(1);
    // Typed while a command ran, in cooked mode: a whole line and the start of the next.
    terminal.input("true\rec");
    expect(shown()).toBe("true\r\nec");
    // The shell's prompt turns raw mode on and reads.
    terminal.setRaw(true, 1);
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("true\n");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ec");
    terminal.input("ho\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ho\r");
    // Nothing of it is left for the next cooked line.
    terminal.setRaw(false, 1);
    terminal.input("zz\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("zz\n");
  });

  it("gives a raw reader an end of file typed before raw mode came on as the key it was", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    // Typed while a command ran: `ab`, Ctrl+D (which ends the read of `ab`), Ctrl+D (end of file).
    terminal.input("ab\x04\x04");
    terminal.setRaw(true, 1);
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("ab");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("\x04");
    expect(terminal.take(100, 1)).toBeUndefined();
    // Read by nobody, it is an end of file again for a cooked reader.
    terminal.setRaw(false, 1);
    terminal.input("\x04");
    terminal.setRaw(true, 1);
    terminal.setRaw(false, 1);
    expect(terminal.take(100, 1)).toBeNull();
  });

  it("wakes a waiting reader with the unfinished line when raw mode comes on", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.input("ec");
    const got: string[] = [];
    terminal.whenReadable(1, () => got.push(decoder.decode(terminal.take(100, 1)!)));
    terminal.setRaw(true, 1);
    expect(got).toEqual(["ec"]);
  });

  it("discards what was typed ahead on Ctrl+C, as a terminal flushes its input queue", () => {
    const { terminal, shown, interrupts } = echoing();
    terminal.attach(1);
    terminal.input("echo queued\rhal");
    terminal.input("\x04");
    terminal.input("\x04");
    terminal.input("f\x03");
    expect(interrupts).toEqual([1]);
    expect(shown()).toBe("echo queued\r\nhalf^C\r\n");
    // Neither the line, nor the flushed part, nor the end-of-file mark, nor the unfinished line is left.
    expect(terminal.take(100, 1)).toBeUndefined();
    terminal.input("next\r");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("next\n");
  });

  it("keeps what was typed ahead when Ctrl+C is a key (raw mode)", () => {
    const { terminal, interrupts } = echoing();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.input("a");
    terminal.input("\x03");
    expect(interrupts).toEqual([]);
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("a");
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("\x03");
  });

  it("acts on a Ctrl+C typed ahead once a reader reads it, outside the read", async () => {
    const { terminal, interrupts } = echoing();
    terminal.attach(1);
    terminal.setRaw(true, 1);
    terminal.input("x\x03y\r");
    terminal.setRaw(false, 1);
    expect(interrupts).toEqual([]);
    expect(decoder.decode(terminal.take(100, 1)!)).toBe("y\n");
    expect(interrupts).toEqual([]);
    await Promise.resolve();
    expect(interrupts).toEqual([1]);
  });

  it("gives the lines it retypes to the reader that reads, not to one waiting behind it", () => {
    const terminal = makeTerminal();
    terminal.attach(1);
    terminal.attach(2);
    terminal.setRaw(true, 2);
    terminal.input("ab\r");
    terminal.setRaw(false, 2);
    // An older reader waits; the newer one reads, which edits the keys typed ahead.
    const older: string[] = [];
    terminal.whenReadable(1, () => {
      const chunk = terminal.take(100, 1);
      older.push(chunk ? decoder.decode(chunk) : "nothing");
    });
    expect(decoder.decode(terminal.take(100, 2)!)).toBe("ab\n");
    expect(older).toEqual([]);
  });
});
