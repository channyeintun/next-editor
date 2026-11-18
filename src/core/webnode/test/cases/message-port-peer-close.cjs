// The end of a MessageChannel that nobody listens to for messages, as Node
// has it: it emits 'close' when its peer closes, unless messages wait for a
// listener; then 'close' comes after a later listener got them, or after
// start() dropped them. Such an end does not hold the process.
"use strict";
const { MessageChannel } = require("worker_threads");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.on("close", () => log.push("peer close"));
    port1.on("close", () => log.push("close"));
    port1.on("message", (m) => {
      log.push(m);
      if (m === 1) port1.close();
    });
    port2.postMessage(1);
    port2.postMessage(2);
    await wait(30);
    console.log(`the sender's end, closed by the other's listener: ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.addEventListener("close", () => log.push("close"));
    port1.close();
    await wait(30);
    console.log(`addEventListener('close'), nothing waits: ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.on("close", () => log.push("closer"));
    port1.on("close", () => log.push("not started"));
    port1.postMessage(1);
    await wait(10);
    port2.close();
    await wait(30);
    console.log(`an end nobody started, its peer closes: ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port1.close();
    port2.on("close", () => log.push("close"));
    await wait(30);
    console.log(`'close' listener added after the peer's close(): ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.on("close", () => {
      log.push("close");
      process.nextTick(() => log.push("close>t"));
    });
    port1.postMessage(1);
    port1.postMessage(2);
    port1.close();
    await wait(30);
    log.push("|");
    port2.on("message", (m) => {
      log.push(m);
      process.nextTick(() => log.push(`t${m}`));
    });
    await wait(30);
    console.log(`messages wait, a listener comes later: ${log.join(" ")}`);
    port2.close();
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.on("close", () => log.push("close"));
    port1.postMessage(1);
    port1.postMessage(2);
    await wait(30);
    port2.on("message", (m) => log.push(m));
    await wait(30);
    port1.postMessage(3);
    await wait(30);
    port1.close();
    await wait(30);
    console.log(`messages wait, no close: ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.on("close", () => log.push("close"));
    port1.postMessage(1);
    port1.close();
    await wait(30);
    log.push("|");
    port2.start();
    await wait(30);
    console.log(`start() with nobody listening drops what waited: ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    const listener = (m) => log.push(m);
    port2.on("message", listener);
    port2.on("close", () => log.push("close"));
    port1.postMessage(1);
    await wait(10);
    port2.off("message", listener);
    port1.postMessage(2);
    port1.postMessage(3);
    port1.close();
    await wait(30);
    log.push("|");
    port2.on("message", listener);
    await wait(30);
    console.log(`a stopped end holds the peer's close behind its messages: ${log.join(" ")}`);
  }
  {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port2.on("close", () => log.push("close"));
    port1.postMessage(1);
    port1.close();
    await wait(30);
    console.log(`messages nobody reads keep the close back: [${log.join(" ")}]`);
  }
})();

// Never closed: a 'close' listener does not hold the process.
const idle = new MessageChannel();
idle.port2.on("close", () => console.log("idle closed"));
