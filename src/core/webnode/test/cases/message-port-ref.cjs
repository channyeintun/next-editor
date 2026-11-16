// What keeps a process alive through a MessagePort. A port with no "message"
// listener does not; `ref()` holds the process until `unref()`, listener or
// not (emnapi's async work relies on that); a "message" listener holds it
// until the listener is removed.
const { MessageChannel } = require("worker_threads");

const order = [];
process.on("exit", () => console.log(order.join(" > "), "> exit"));

// Never referenced: the timers below are unref'd, so only the ports hold the process.
const idle = new MessageChannel();
idle.port1.postMessage("never read");

const held = new MessageChannel();
held.port1.ref();
setTimeout(() => {
  order.push("ref held the process");
  held.port1.unref();

  const listening = new MessageChannel();
  const onMessage = (message) => {
    order.push(`listener got ${message}`);
    listening.port2.off("message", onMessage);
  };
  listening.port2.on("message", onMessage);
  setTimeout(() => {
    order.push("listener held the process");
    listening.port1.postMessage("ping");
  }, 30).unref();
}, 30).unref();
