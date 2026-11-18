// AsyncLocalStorage across process.nextTick, and across the callbacks net,
// http and streams defer with it: a request logger that reads the store in
// 'finish' is the usual shape.
"use strict";
const { AsyncLocalStorage } = require("async_hooks");
const http = require("http");
const net = require("net");
const { Writable } = require("stream");
const als = new AsyncLocalStorage();
const seen = {};
const note = (name) => () => {
  seen[name] = als.getStore();
};

als.run("A", () => {
  process.nextTick(() => {
    note("tick")();
    process.nextTick(note("tick>tick"));
  });
  setImmediate(() => process.nextTick(() => process.nextTick(note("immediate>tick>tick"))));
  setTimeout(() => process.nextTick(note("timer>tick")), 1);
  Promise.resolve().then(() => process.nextTick(note("promise>tick")));
});
process.nextTick(note("outside"));

const sink = new Writable({ write: (chunk, encoding, callback) => callback() });
als.run("W", () => {
  sink.write("x", note("write callback"));
  sink.end(note("end callback"));
  sink.on("finish", note("finish"));
});

const tcp = net.createServer();
als.run("N", () => {
  tcp.listen(0, note("listening"));
  tcp.on("listening", () => tcp.close(note("closed")));
});

let requests = 0;
const server = http.createServer((request, response) => {
  als.run({ id: ++requests }, () => {
    response.on("finish", () =>
      console.log("request", als.getStore().id, "->", response.statusCode),
    );
    response.write("o", () => process.nextTick(() => response.end("k")));
  });
});
server.listen(0, () => {
  const get = (done) =>
    http.get({ port: server.address().port, agent: false }, (response) => {
      response.resume();
      response.on("end", done);
    });
  get(() =>
    get(() => {
      server.close();
      console.log(
        Object.keys(seen)
          .sort()
          .map((name) => `${name}:${seen[name]}`)
          .join(" "),
      );
    }),
  );
});
