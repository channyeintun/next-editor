// BroadcastChannel as Node has it: the channels of one name reach each other
// in one process, its threads included, and no other process; closing one
// leaves the others open; a channel holds the process until close() or unref().
const {
  Worker,
  isMainThread,
  parentPort,
  BroadcastChannel: fromModule,
} = require("worker_threads");
const { spawn } = require("child_process");

const mode = process.argv[2];
if (!isMainThread) {
  const channel = new BroadcastChannel("case");
  channel.onmessage = (event) => {
    if (event.data === "to the thread") {
      channel.postMessage("from the thread");
      channel.close();
    }
  };
  parentPort.postMessage("listening");
} else if (mode === "other-process") {
  const channel = new BroadcastChannel("case");
  channel.onmessage = (event) => console.log("the other process received", event.data);
  channel.postMessage("from another process");
  setTimeout(() => channel.close(), 400);
} else if (mode === "held") {
  new BroadcastChannel("case");
  setTimeout(() => {
    console.log("an open channel held the process");
    process.exit(0);
  }, 200).unref();
} else if (mode === "unref") {
  const channel = new BroadcastChannel("case");
  channel.unref();
  channel.onmessage = () => {};
  channel.addEventListener("message", () => {});
  process.on("exit", () => console.log("an unref'd channel lets the process go, listeners or not"));
} else if (mode === "closed") {
  const channel = new BroadcastChannel("case");
  channel.onmessage = () => {};
  channel.close();
  process.on("exit", () => console.log("a closed channel lets the process go"));
} else {
  main();
}

function child(argument) {
  return new Promise((resolve) => {
    const started = spawn(process.execPath, [__filename, argument], { stdio: "inherit" });
    started.on("exit", resolve);
  });
}

async function main() {
  const first = new BroadcastChannel("iface");
  const numbered = new BroadcastChannel(42);
  console.log(
    "class:",
    fromModule === BroadcastChannel,
    first.constructor.name,
    first instanceof EventTarget,
  );
  console.log(
    "name:",
    JSON.stringify([first.name, numbered.name]),
    Object.prototype.toString.call(first),
  );
  console.log(
    "members:",
    ["on", "once", "emit", "addEventListener", "postMessage", "close", "ref", "unref"]
      .map((name) => `${name}:${typeof first[name]}`)
      .join(" "),
  );
  const failure = (run) => {
    try {
      run();
      return "nothing thrown";
    } catch (error) {
      return `${error.name} ${error.code}`;
    }
  };
  console.log(
    "no name:",
    failure(() => new BroadcastChannel()),
  );
  first.close();
  first.close();
  numbered.close();
  console.log(
    "post after close:",
    failure(() => first.postMessage(1)),
  );

  // Three channels of one name: a posts 1 and closes; b and c go on.
  const a = new BroadcastChannel("case");
  const b = new BroadcastChannel("case");
  const c = new BroadcastChannel("case");
  const got = { a: [], b: [], c: [] };
  a.onmessage = (event) => got.a.push(event.data);
  b.onmessage = (event) => {
    got.b.push(event.data);
    process.nextTick(() => got.b.push("tick"));
  };
  c.addEventListener("message", (event) => got.c.push(`${event.type}:${event.data}`));
  for (const channel of [a, b, c]) {
    channel.addEventListener("close", () => console.log("a 'close' event"));
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  a.postMessage(1);
  await pause(50);
  a.close();
  b.postMessage(2);
  await pause(50);
  console.log("one closed:", JSON.stringify(got));

  // A thread of this process is reached, and reaches back.
  await new Promise((resolve) => {
    const worker = new Worker(__filename);
    worker.on("message", () => b.postMessage("to the thread"));
    worker.on("exit", resolve);
  });
  await pause(50);
  console.log("with a thread:", JSON.stringify(got));

  // Another process with a channel of the same name is not.
  await child("other-process");
  await pause(50);
  console.log("after another process:", JSON.stringify(got));
  b.close();
  c.close();

  for (const hold of ["held", "unref", "closed"]) {
    await child(hold);
  }
}
