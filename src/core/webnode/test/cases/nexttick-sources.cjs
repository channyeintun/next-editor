// Where the callbacks that queue ticks come from, beyond timers and fs: the
// unhandled-rejection machinery, AbortSignal.timeout, MessagePort messages,
// net servers and sockets, child processes, dns.lookup, fs watchers, and
// 'beforeExit'. Each callback logs itself, then
// queues a tick (">t") and a promise job (">p"): Node runs the tick first.
// Also: a rejection handled a few tick rounds later is never reported, a
// listener removed (or a port closed) by ticks still waiting when a message
// arrives gets nothing, and process.nextTick keeps working for a program that
// replaced MessageChannel.
"use strict";
const { spawn } = require("child_process");
const dns = require("dns");
const fs = require("fs");
const net = require("net");
const { Readable, Writable } = require("stream");
const { MessageChannel } = require("worker_threads");

const scenarios = [];
let current = null;

function scenario(name, body) {
  scenarios.push({ name, body });
}

function log(event) {
  current.events.push(event);
}

/** Logs `tag`, then queues a tick and a promise job that log themselves. */
function mark(tag) {
  log(tag);
  process.nextTick(() => log(`${tag}>t`));
  Promise.resolve().then(() => log(`${tag}>p`));
}

function next() {
  if (current) {
    console.log(`${current.name}: ${current.events.join(" ")}`);
  }
  current = scenarios.shift() ?? null;
  if (current) {
    current.events = [];
    current.body(() => setTimeout(next, 20));
  }
}

scenario("rejection handled two tick rounds later", (done) => {
  setTimeout(() => {
    const late = Promise.reject(new Error("late"));
    Promise.resolve().then(() =>
      process.nextTick(() =>
        Promise.resolve().then(() =>
          process.nextTick(() => late.catch((error) => log(`caught ${error.message}`))),
        ),
      ),
    );
    done();
  }, 1);
});

scenario("rejection handled after three awaited writes", (done) => {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const write = (chunk) =>
    new Promise((resolve, reject) =>
      sink.write(chunk, (error) => (error ? reject(error) : resolve())),
    );
  setTimeout(async () => {
    const failing = Promise.reject(new Error("request failed"));
    await write("a");
    await write("b");
    await write("c");
    try {
      await failing;
    } catch (error) {
      log(`handled ${error.message}`);
    }
    done();
  }, 1);
});

scenario("rejection handled after a for await", (done) => {
  setTimeout(async () => {
    const failing = Promise.reject(new Error("x"));
    for await (const chunk of Readable.from(["a", "b", "c"])) {
      log(chunk);
    }
    try {
      await failing;
    } catch (error) {
      log(`handled ${error.message}`);
    }
    done();
  }, 1);
});

scenario("'unhandledRejection' listener", (done) => {
  const onUnhandled = (reason) => {
    mark(`unhandled ${reason}`);
    queueMicrotask(() => log("q"));
  };
  process.on("unhandledRejection", onUnhandled);
  setTimeout(() => {
    Promise.reject(1);
    setTimeout(() => {
      process.off("unhandledRejection", onUnhandled);
      done();
    }, 10);
  }, 1);
});

scenario("'rejectionHandled' listener", (done) => {
  const onUnhandled = (reason) => log(`unhandled ${reason}`);
  const onHandled = () => mark("rejectionHandled");
  process.on("unhandledRejection", onUnhandled);
  process.on("rejectionHandled", onHandled);
  setTimeout(() => {
    const rejected = Promise.reject(2);
    setTimeout(() => {
      rejected.catch(() => log("caught late"));
      setTimeout(() => {
        process.off("unhandledRejection", onUnhandled);
        process.off("rejectionHandled", onHandled);
        done();
      }, 10);
    }, 5);
  }, 1);
});

scenario("AbortSignal.timeout", (done) => {
  const signal = AbortSignal.timeout(5);
  signal.addEventListener("abort", () => mark(`abort ${signal.reason.name}`));
  // The signal's own timer does not keep the process alive.
  setTimeout(done, 30);
});

scenario("port listener removed by waiting ticks", (done) => {
  const { port1, port2 } = new MessageChannel();
  let removed = false;
  const onMessage = (message) => log(`got ${message} after off: ${removed}`);
  port1.on("message", onMessage);
  (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    port2.postMessage("x");
    for await (const chunk of Readable.from(["a", "b", "c"])) {
      void chunk;
    }
    port1.off("message", onMessage);
    removed = true;
    log("removed");
    setTimeout(() => {
      port1.close();
      done();
    }, 10);
  })();
});

scenario("port closed by waiting ticks", (done) => {
  const { port1, port2 } = new MessageChannel();
  let closed = false;
  port1.on("message", (message) => log(`got ${message} after close: ${closed}`));
  port1.addEventListener("message", (event) => log(`event ${event.data} after close: ${closed}`));
  port1.onmessage = (event) => log(`onmessage ${event.data} after close: ${closed}`);
  (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    port2.postMessage("x");
    for await (const chunk of Readable.from(["a", "b", "c"])) {
      void chunk;
    }
    port1.close();
    closed = true;
    log("closed");
    setTimeout(done, 10);
  })();
});

scenario("two message listeners, one message", (done) => {
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (message) => mark(`A${message}`));
  port1.on("message", (message) => mark(`B${message}`));
  port2.postMessage(1);
  setTimeout(() => {
    port1.close();
    done();
  }, 10);
});

scenario("server listen and close", (done) => {
  const server = net.createServer();
  server.listen(0, () => {
    mark("listen");
    server.close(() => {
      mark("close");
      setTimeout(done, 5);
    });
  });
});

scenario("socket connect", (done) => {
  const server = net.createServer((socket) => socket.end());
  server.listen(0, () => {
    const { port } = server.address();
    const byAddress = net.connect(port, "127.0.0.1", () => mark("connect"));
    byAddress.resume();
    byAddress.on("close", () => {
      const byName = net.connect(port, "localhost", () => mark("connect by name"));
      byName.resume();
      byName.on("close", () => server.close(() => setTimeout(done, 5)));
    });
  });
});

/** What the caller queues after starting something, in the same callback. */
function callerQueues() {
  process.nextTick(() => log("caller>t"));
  Promise.resolve().then(() => log("caller>p"));
}

scenario("spawn", (done) => {
  setTimeout(() => {
    const child = spawn("node", ["-e", ""]);
    child.on("spawn", () => mark("spawn"));
    child.on("close", () => setTimeout(done, 5));
    callerQueues();
  }, 1);
});

scenario("spawn that cannot start", (done) => {
  setTimeout(() => {
    const child = spawn("definitely-not-a-command-xyz", [], { stdio: "inherit" });
    child.on("error", (error) => mark(`error ${error.code}`));
    child.on("close", (code) => {
      mark(`close ${code}`);
      setTimeout(done, 5);
    });
    callerQueues();
  }, 1);
});

scenario("spawn that cannot start, with pipes", (done) => {
  setTimeout(() => {
    const child = spawn("definitely-not-a-command-xyz");
    child.on("error", (error) => mark(`error ${error.code}`));
    child.stdout.on("end", () => mark("stdout end"));
    child.on("close", (code) => {
      mark(`close ${code}`);
      setTimeout(done, 5);
    });
    callerQueues();
  }, 1);
});

scenario("spawn with an aborted signal", (done) => {
  setTimeout(() => {
    const controller = new AbortController();
    controller.abort();
    const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
      signal: controller.signal,
    });
    child.on("spawn", () => mark("spawn"));
    child.on("error", (error) => mark(`error ${error.name}`));
    child.on("close", () => setTimeout(done, 5));
    process.nextTick(() => log("caller>t"));
  }, 1);
});

scenario("dns.lookup", (done) => {
  setTimeout(() => {
    dns.lookup("localhost", () => {
      mark("by name");
      dns.lookup("127.0.0.1", () => {
        mark("by address");
        setTimeout(done, 5);
      });
      callerQueues();
    });
    callerQueues();
  }, 1);
});

scenario("fs.watch close and fs.watchFile", (done) => {
  fs.writeFileSync("nexttick-watched.txt", "a");
  setTimeout(() => {
    const watcher = fs.watch(".");
    watcher.on("close", () => mark("close"));
    watcher.close();
    callerQueues();
    fs.watchFile("nexttick-watched.txt", { interval: 20 }, () => {
      mark("change");
      fs.unwatchFile("nexttick-watched.txt");
      setTimeout(() => {
        fs.rmSync("nexttick-watched.txt");
        done();
      }, 10);
    });
    setTimeout(() => fs.writeFileSync("nexttick-watched.txt", "bb"), 100);
  }, 1);
});

scenario("read() takes the first chunk", (done) => {
  const readable = new Readable({ read() {} });
  readable.push("a");
  readable.push("b");
  log(String(readable.read()));
  log(String(readable.read()));
  let chunks = 0;
  (async () => {
    const source = new Readable({ read() {} });
    for (let i = 0; i < 5; i += 1) {
      source.push(`c${i}`);
    }
    source.push(null);
    for await (const chunk of source) {
      void chunk;
      chunks += 1;
    }
    log(`for await: ${chunks} chunks`);
    done();
  })();
});

scenario("nextTick with MessageChannel replaced", (done) => {
  const saved = globalThis.MessageChannel;
  globalThis.MessageChannel = undefined;
  setTimeout(() => {
    Promise.resolve().then(() =>
      process.nextTick(() =>
        Promise.resolve().then(() =>
          process.nextTick(() => {
            log("second tick ran");
            globalThis.MessageChannel = saved;
          }),
        ),
      ),
    );
    setTimeout(done, 10);
  }, 1);
});

next();

let beforeExits = 0;
process.on("beforeExit", () => {
  beforeExits += 1;
  if (beforeExits === 1) {
    current = { name: "beforeExit", events: [] };
    mark("beforeExit");
  }
});
process.on("exit", (code) => {
  if (current) {
    console.log(`${current.name}: ${current.events.join(" ")}`);
  }
  console.log("beforeExit count", beforeExits, "exit", code);
});
