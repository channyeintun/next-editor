// A MessagePort's listeners as Node has them: a first 'message' listener of
// any kind starts the port, the last one to go stops it (what comes then
// waits for the next), and 'close' reaches listeners of both kinds, from the
// event loop.
const { MessageChannel } = require("worker_threads");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closed = (port) => new Promise((resolve) => port.on("close", resolve));

(async () => {
  {
    // Only addEventListener: the port is started, and the process waits for it.
    const { port1, port2 } = new MessageChannel();
    const got = new Promise((resolve) =>
      port1.addEventListener("message", (event) => resolve(event.data)),
    );
    port2.postMessage("hello");
    console.log("addEventListener alone:", await got);
    port1.close();
  }
  {
    const { port1, port2 } = new MessageChannel();
    const seen = [];
    const first = (value) => {
      seen.push(`first:${value}`);
      port1.off("message", first);
    };
    port1.on("message", first);
    for (const value of [1, 2, 3]) port2.postMessage(value);
    await pause(30);
    port1.on("message", (value) => seen.push(`second:${value}`));
    await pause(30);
    console.log("off, then on:", seen.join(" "));
    port1.close();
  }
  {
    const { port1, port2 } = new MessageChannel();
    const seen = [];
    port1.onmessage = (event) => {
      seen.push(`h1:${event.data}`);
      port1.onmessage = null;
    };
    port2.postMessage(1);
    port2.postMessage(2);
    await pause(30);
    port1.addEventListener("message", (event) => seen.push(`listener:${event.data}`), {
      once: true,
    });
    await pause(30);
    port1.once("message", (value) => seen.push(`once:${value}`));
    port2.postMessage(3);
    await pause(30);
    console.log("onmessage = null, then listeners that go:", seen.join(" "));
    port1.close();
  }
  {
    // start() with nobody listening: what was posted is gone.
    const { port1, port2 } = new MessageChannel();
    const seen = [];
    port1.start();
    port2.postMessage(1);
    await pause(30);
    port1.on("message", (value) => seen.push(value));
    port2.postMessage(2);
    await pause(30);
    console.log("start() without a listener:", seen.join(" "));
    port1.close();
  }
  {
    // A listener an earlier listener of the same message removed gets nothing;
    // stopImmediatePropagation stops the later ones, of every kind.
    const { port1, port2 } = new MessageChannel();
    const seen = [];
    const second = (value) => seen.push(`second:${value}`);
    port2.on("message", (value) => {
      seen.push(`first:${value}`);
      if (value === 1) port2.off("message", second);
    });
    port2.on("message", second);
    port2.addEventListener("message", (event) => {
      seen.push(`third:${event.data}`);
      event.stopImmediatePropagation();
      Promise.resolve().then(() => process.nextTick(() => seen.push(`tick:${event.data}`)));
    });
    port2.on("message", (value) => seen.push(`fourth:${value}`));
    port1.postMessage(1);
    port1.postMessage(2);
    await pause(30);
    console.log("removed and stopped:", seen.join(" "));
    port2.close();
  }
  {
    const { port1, port2 } = new MessageChannel();
    const seen = [];
    port1.on("close", (...args) => seen.push(`on ${args.length} ${args[0].type}`));
    port1.addEventListener("close", (event) =>
      seen.push(`listener ${event.type} ${event.target === port1} ${event instanceof Event}`),
    );
    port2.addEventListener("close", () => seen.push("other end"));
    port2.on("message", () => {});
    port1.close();
    seen.push("after close()");
    process.nextTick(() => seen.push("tick"));
    port1.once("close", () => seen.push("added after close()"));
    await closed(port2);
    await pause(30);
    console.log("close:", seen.join(" | "));
  }
  {
    // What was posted before the other end closed still arrives, then 'close'.
    const { port1, port2 } = new MessageChannel();
    const seen = [];
    port1.on("message", (value) => seen.push(value));
    for (const value of [1, 2, 3]) port2.postMessage(value);
    port2.close();
    await closed(port1);
    console.log("the other end closes after posting:", seen.join(" "));
  }
  {
    // A spy on postMessage sees the program's messages and nothing else.
    const { port1, port2 } = new MessageChannel();
    const original = MessagePort.prototype.postMessage;
    const calls = [];
    MessagePort.prototype.postMessage = function (...args) {
      calls.push(JSON.stringify(args[0]));
      return original.apply(this, args);
    };
    port2.on("message", () => {});
    port1.postMessage("mine");
    port1.close();
    await closed(port2);
    MessagePort.prototype.postMessage = original;
    console.log("a postMessage spy saw:", calls.join(" "));
  }
})();
