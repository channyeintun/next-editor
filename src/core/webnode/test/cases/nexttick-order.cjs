// The order of process.nextTick callbacks, promise jobs, queueMicrotask,
// setImmediate, setTimeout(0) and await, nested in each other, from every kind
// of place a callback runs: the main module, a timer, an immediate, a promise
// job, an async function after await, an EventEmitter listener, a stream
// 'data' handler, a MessagePort message, an fs callback and a tick. Node runs
// all ticks, then all promise jobs, and repeats until both are empty, before
// the next macrotask. Each scenario prints its events in the order they ran.
"use strict";
const { EventEmitter } = require("events");
const fs = require("fs");
const { Readable, Writable, Transform, pipeline } = require("stream");
const { MessageChannel } = require("worker_threads");

const scenarios = [];
let current = null;

function scenario(name, expected, body) {
  scenarios.push({ name, expected, body });
}

function log(event) {
  current.events.push(event);
  if (current.events.length === current.expected) {
    // The next scenario starts from a timer of its own, once this one is quiet.
    setTimeout(next, 5);
  }
}

function next() {
  if (current) {
    console.log(`${current.name}: ${current.events.join(" ")}`);
  }
  current = scenarios.shift() ?? null;
  if (current) {
    current.events = [];
    current.body();
  }
}

/** Ticks, promise jobs and microtasks queued from wherever this runs (9 events). */
function mix(tag = "") {
  process.nextTick(() => log(`${tag}t1`));
  Promise.resolve().then(() => {
    log(`${tag}p1`);
    process.nextTick(() => log(`${tag}p1>t`));
    Promise.resolve().then(() => log(`${tag}p1>p`));
  });
  queueMicrotask(() => {
    log(`${tag}q1`);
    process.nextTick(() => log(`${tag}q1>t`));
  });
  process.nextTick(() => {
    log(`${tag}t2`);
    Promise.resolve().then(() => log(`${tag}t2>p`));
    process.nextTick(() => log(`${tag}t2>t`));
    queueMicrotask(() => log(`${tag}t2>q`));
  });
  log(`${tag}sync`);
}
const MIX = 11;

scenario("main module", MIX, () => mix());
scenario("timer", MIX, () => setTimeout(() => mix(), 1));
scenario("immediate", MIX, () => setImmediate(() => mix()));
scenario("promise job", MIX, () => Promise.resolve().then(() => mix()));
scenario("queueMicrotask", MIX, () => queueMicrotask(() => mix()));
scenario("tick", MIX, () => process.nextTick(() => mix()));

scenario("after await", MIX + 5, () => {
  (async () => {
    await Promise.resolve();
    mix();
    await Promise.resolve();
    log("await2");
    process.nextTick(() => log("await2>t"));
    Promise.resolve().then(() => log("await2>p"));
    await new Promise((resolve) => process.nextTick(resolve));
    log("await3");
    await new Promise((resolve) => setImmediate(resolve));
    log("await4");
  })();
});

scenario("issue example", 2, () => {
  Promise.resolve().then(() => {
    process.nextTick(() => log("tick"));
    Promise.resolve().then(() => log("p"));
  });
});

scenario("tick from a tick", 8, () => {
  process.nextTick(() => {
    log("a");
    process.nextTick(() => {
      log("a>t");
      process.nextTick(() => log("a>t>t"));
      Promise.resolve().then(() => log("a>t>p"));
    });
    Promise.resolve().then(() => {
      log("a>p");
      process.nextTick(() => log("a>p>t"));
    });
  });
  process.nextTick(() => log("b"));
  Promise.resolve().then(() => log("p"));
});

scenario("emit in a promise job", MIX + 2, () => {
  const emitter = new EventEmitter();
  emitter.on("go", () => mix());
  emitter.once("go", () => log("once"));
  Promise.resolve().then(() => {
    emitter.emit("go");
    log("after emit");
  });
});

scenario("emit in a timer", MIX + 1, () => {
  const emitter = new EventEmitter();
  emitter.on("go", () => mix());
  setTimeout(() => {
    emitter.emit("go");
    log("after emit");
  }, 1);
});

scenario("stream data", 2 * MIX + 3, () => {
  const stream = new Readable({ read() {} });
  stream.on("data", (chunk) => {
    log(`data:${chunk}`);
    mix(`${chunk}.`);
  });
  stream.on("end", () => log("end"));
  setTimeout(() => {
    stream.push("a");
    stream.push("b");
    stream.push(null);
  }, 1);
});

scenario("write callbacks after await", 7, () => {
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      log(`write:${chunk}`);
      callback();
    },
  });
  sink.on("finish", () => log("finish"));
  (async () => {
    await Promise.resolve();
    sink.write("a", () => log("cb:a"));
    Promise.resolve().then(() => log("p"));
    sink.end("b", () => log("cb:end"));
    log("sync");
  })();
});

scenario("for await over a readable", 18, () => {
  let i = 0;
  const source = new Readable({
    objectMode: true,
    read() {
      log(`read${i}`);
      this.push(i < 4 ? i++ : null);
    },
  });
  (async () => {
    for await (const x of source) {
      log(`x${x}`);
      process.nextTick(() => log(`x${x}>t`));
      Promise.resolve().then(() => log(`x${x}>p`));
    }
    log("done");
  })();
});

scenario("pipeline of transforms", 1, () => {
  let i = 0;
  const source = new Readable({
    read() {
      this.push(i < 50 ? `c${i++}` : null);
    },
  });
  const pass = () =>
    new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    });
  const sizes = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      sizes.push(chunk.length);
      callback();
    },
  });
  pipeline(source, pass(), pass(), sink, () => log(`writes=${sizes.length}`));
});

scenario("macrotasks in a timer", 10, () => {
  setTimeout(() => {
    setTimeout(() => log("timeout"), 0);
    setImmediate(() => {
      log("immediate");
      process.nextTick(() => log("immediate>t"));
      Promise.resolve().then(() => log("immediate>p"));
    });
    setImmediate(() => log("immediate2"));
    Promise.resolve().then(() => {
      log("p");
      process.nextTick(() => log("p>t"));
      setImmediate(() => log("p>immediate"));
    });
    process.nextTick(() => {
      log("t");
      setImmediate(() => log("t>immediate"));
    });
  }, 1);
});

scenario("fs callback", 6, () => {
  fs.readFile(__filename, () => {
    setTimeout(() => log("timeout"), 0);
    setImmediate(() => log("immediate"));
    Promise.resolve().then(() => {
      log("p");
      process.nextTick(() => log("p>t"));
    });
    process.nextTick(() => log("t"));
    log("sync");
  });
});

scenario("two timers due together", 5, () => {
  setTimeout(() => {
    log("A");
    Promise.resolve().then(() =>
      process.nextTick(() => {
        log("A>p>t");
        Promise.resolve().then(() => log("A>p>t>p"));
        process.nextTick(() => log("A>p>t>t"));
      }),
    );
  }, 3);
  setTimeout(() => log("B"), 3);
});

scenario("message port", MIX + 1, () => {
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (value) => {
    log(`message:${value}`);
    mix();
    port1.close();
  });
  port2.postMessage(1);
});

scenario("uncaught exceptions", 10, () => {
  const onError = (error) => {
    log(`caught:${error.message}`);
    Promise.resolve().then(() => log(`caught:${error.message}>p`));
    process.nextTick(() => log(`caught:${error.message}>t`));
  };
  process.on("uncaughtException", onError);
  setTimeout(() => {
    process.nextTick(() => {
      throw new Error("tick");
    });
    process.nextTick(() => log("t2"));
    Promise.resolve().then(() => log("p"));
    setTimeout(() => {
      process.nextTick(() => log("B>t"));
      Promise.resolve().then(() => log("B>p"));
      setTimeout(() => process.off("uncaughtException", onError), 5);
      throw new Error("timer");
    }, 1);
  }, 1);
});

next();
process.on("exit", (code) => {
  if (current) {
    console.log(`${current.name} (unfinished): ${current.events.join(" ")}`);
  }
  console.log("exit", code);
});
