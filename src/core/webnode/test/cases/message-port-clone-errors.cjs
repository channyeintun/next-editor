// A value that cannot be cloned gives Node's DataCloneError, with Node's
// message: through a MessagePort (with and without a transfer list), a
// Worker, a thread's parentPort, a BroadcastChannel (with and without
// another channel of its name) and structuredClone. And what ref() and
// unref() answer: undefined on a MessagePort, the channel on a
// BroadcastChannel.
const { MessageChannel, Worker } = require("worker_threads");

const tryClone = (label, send) => {
  try {
    send();
    console.log(label, "sent");
  } catch (e) {
    console.log(label, e.constructor.name, e.name, e.code, JSON.stringify(e.message));
  }
};

const { port1, port2 } = new MessageChannel();
tryClone("port, a function", () => port1.postMessage(() => {}));
tryClone("port, a symbol", () => port1.postMessage(Symbol("s")));
tryClone("port, inside an object, with a transfer list", () =>
  port1.postMessage({ f: function named() {} }, []),
);
tryClone("structuredClone, a function", () => structuredClone(() => 1));
tryClone("structuredClone, a WeakMap", () => structuredClone({ m: new WeakMap() }));
console.log("port ref unref", typeof port1.ref(), typeof port1.unref());
port1.close();
port2.close();

const lonely = new BroadcastChannel("lonely");
tryClone("channel alone, a function", () => lonely.postMessage(() => {}));
const a = new BroadcastChannel("pair");
const b = new BroadcastChannel("pair");
b.onmessage = () => {};
tryClone("channel with another, a symbol", () => a.postMessage(Symbol("x")));
console.log("channel ref", a.ref() === a, "unref", a.unref() === a);
lonely.close();
a.close();
b.close();

const worker = new Worker(
  `const { parentPort } = require("worker_threads");
   try { parentPort.postMessage(() => {}); } catch (e) { parentPort.postMessage(["thread", e.name, e.message]); }`,
  { eval: true },
);
tryClone("worker, a function", () => worker.postMessage(() => {}));
worker.on("message", (m) => console.log(...m));
