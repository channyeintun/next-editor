// A MessagePort closed by its own listeners, as Node has it: the messages it
// had received by then still reach them, a message its peer posts in the
// same task too, and only then is 'close' emitted. Its delivery takes in
// the ticks and promise jobs that follow the message, the ticks a promise job
// queued among them. It sends nothing more, it cannot be transferred (nor
// moved by structuredClone), and unref() does not cut the delivery short. A
// port closed outside its own delivery gets nothing more.
"use strict";
const { MessageChannel } = require("worker_threads");

const run = (label, body) =>
  new Promise((resolve) => {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port1.on("close", () => {
      log.push("close");
      setTimeout(() => {
        console.log(`${label}: ${log.join(" ")}`);
        resolve();
      }, 20);
    });
    body(port1, port2, log);
  });

(async () => {
  {
    // Listeners, ticks and promise jobs against a close() from a tick.
    const log = [];
    const { port1, port2 } = new MessageChannel();
    const l1 = (m) => {
      log.push(`l1:${m}`);
      process.nextTick(() => log.push(`l1>t:${m}`));
      Promise.resolve().then(() => log.push(`l1>p:${m}`));
    };
    const l2 = (m) => {
      log.push(`l2:${m}`);
      if (m === 2) {
        process.nextTick(() => {
          log.push("off l1");
          port1.off("message", l1);
        });
      }
      if (m === 4) {
        process.nextTick(() => {
          log.push("close");
          port1.close();
          setImmediate(() => log.push("imm"));
        });
      }
    };
    port1.on("message", l1);
    port1.on("message", l2);
    const closed = new Promise((resolve) =>
      port1.on("close", () => {
        log.push("close event");
        process.nextTick(() => {
          log.push("close>t");
          resolve();
        });
      }),
    );
    for (let i = 1; i <= 6; i++) port2.postMessage(i);
    await closed;
    console.log(log.join(" "));
  }
  await run("close() right after posts", (p1, p2, log) => {
    p1.on("message", (m) => log.push(m));
    for (let i = 1; i <= 3; i++) p2.postMessage(i);
    p1.close();
    log.push("closed");
  });
  await run("close() in the listener at 2 of 5", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 2) {
        p1.close();
        log.push("closed");
      }
    });
    for (let i = 1; i <= 5; i++) p2.postMessage(i);
  });
  await run("close() in a tick of the listener at 2 of 5", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 2) {
        process.nextTick(() => {
          p1.close();
          log.push("closed");
        });
      }
    });
    for (let i = 1; i <= 5; i++) p2.postMessage(i);
  });
  await run("close() in a promise job of the listener at 2 of 5", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 2) {
        Promise.resolve().then(() => {
          p1.close();
          log.push("closed");
        });
      }
    });
    for (let i = 1; i <= 5; i++) p2.postMessage(i);
  });
  await run("close() in a tick a promise job of the listener queued, at 2 of 5", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 2) {
        Promise.resolve().then(() =>
          process.nextTick(() => {
            p1.close();
            log.push("closed");
          }),
        );
      }
    });
    for (let i = 1; i <= 5; i++) p2.postMessage(i);
  });
  await run("close() in a tick a promise job queued, past 16 messages", (p1, p2, log) => {
    p1.on("message", (m) => {
      if (m > 16) log.push(m);
      if (m === 18) {
        Promise.resolve().then(() =>
          process.nextTick(() => {
            p1.close();
            log.push("closed");
          }),
        );
      }
    });
    for (let i = 1; i <= 20; i++) p2.postMessage(i);
  });
  await run("close() in a tick a timer queued", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 1) {
        setTimeout(() =>
          process.nextTick(() => {
            p1.close();
            log.push("closed");
            p2.postMessage("late");
          }),
        );
      }
    });
    p2.postMessage(1);
  });
  await run("close() in the listener at 1, the peer posts after it", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 1) {
        p1.close();
        p2.postMessage("late");
        log.push("closed");
      }
    });
    p2.postMessage(1);
    p2.postMessage(2);
  });
  await run("close() in an immediate after posts", (p1, p2, log) => {
    p1.on("message", (m) => log.push(m));
    setImmediate(() => {
      for (let i = 1; i <= 3; i++) p2.postMessage(i);
      p1.close();
      log.push("closed");
    });
  });
  await run("a closed port sends nothing", (p1, p2, log) => {
    p2.on("message", (m) => log.push(`p2:${m}`));
    p1.on("message", (m) => {
      log.push(m);
      if (m === 1) {
        p1.close();
        p1.postMessage("from the closed port");
      }
    });
    p2.postMessage(1);
    p2.postMessage(2);
    setTimeout(() => p2.close(), 40);
  });
  await run("unref() then close() in the listener", (p1, p2, log) => {
    p1.on("message", (m) => {
      log.push(m);
      if (m === 1) {
        p1.unref();
        p1.close();
      }
    });
    for (let i = 1; i <= 3; i++) p2.postMessage(i);
  });
  await run("a closed port is not transferred", (p1, p2, log) => {
    const other = new MessageChannel();
    p1.on("message", (m) => {
      log.push(m);
      if (m === 1) {
        p1.close();
        try {
          other.port1.postMessage(p1, [p1]);
          log.push("transferred");
        } catch (error) {
          log.push(`${error.name} ${error.code} ${error.message}`);
        }
        try {
          structuredClone(p1, { transfer: [p1] });
          log.push("cloned");
        } catch (error) {
          log.push(`structuredClone: ${error.name} ${error.code} ${error.message}`);
        }
        other.port1.close();
      }
    });
    p2.postMessage(1);
    p2.postMessage(2);
  });
  {
    const { port1 } = new MessageChannel();
    const other = new MessageChannel();
    port1.close();
    try {
      other.port1.postMessage(port1, [port1]);
      console.log("closed, then transferred: transferred");
    } catch (error) {
      console.log(`closed, then transferred: ${error.name}`);
    }
    try {
      structuredClone({ port1 }, { transfer: [port1] });
      console.log("closed, then cloned: cloned");
    } catch (error) {
      console.log(
        `closed, then cloned: ${error.name} ${error.code} ${error.message} ${error instanceof DOMException}`,
      );
    }
    const open = new MessageChannel();
    const moved = structuredClone(open.port1, { transfer: [open.port1] });
    console.log(`open, then cloned: ${typeof moved.postMessage}`);
    moved.close();
    other.port1.close();
  }
})();
