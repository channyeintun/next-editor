// A connection a server drops for maxConnections is reset when its client
// already sent data and ends cleanly when it sent nothing. A second connect()
// by name while the first is still in flight cancels it (ECANCELED); by
// address it fails with EALREADY.
const net = require("net");

function drop(mode) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on("error", () => {}));
    server.maxConnections = 0;
    const events = [];
    server.on("drop", () => events.push("drop"));
    server.listen(0, "127.0.0.1", () => {
      const client = net.connect(server.address().port, "127.0.0.1", () => {
        if (mode === "write") client.write("hello");
      });
      client.on("error", (error) => events.push(`error ${error.code}`));
      client.on("end", () => events.push("end"));
      client.on("close", (hadError) => {
        events.push(`close ${hadError}`);
        console.log(
          `client that ${mode === "write" ? "wrote" : "sent nothing"}: ${events.join(" ")}`,
        );
        server.close(resolve);
      });
      client.resume();
    });
  });
}

function twice(host) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on("error", () => {}));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const events = [];
      // Whether the first attempt still connects after an EALREADY is a race
      // in Node too: only the failure is shown.
      const client = net.connect(port, host);
      client.connect(port, host);
      client.on("error", (error) => {
        events.push(
          `error ${error.code} ${error.name} ${error.syscall} ${error.message === "" ? "(no message)" : error.message.replace(/:\d+/, ":PORT").split(" - ")[0]}`,
        );
        if (error.errors)
          events.push(
            `of ${error.errors.map((inner) => `${inner.code} ${inner.syscall}`).join(", ")}`,
          );
      });
      client.on("close", (hadError) => {
        events.push(`close ${hadError}`);
        console.log(`connect twice to ${host}: ${events.join(" | ")}`);
        server.close(resolve);
      });
      setTimeout(() => client.destroy(), 200);
    });
  });
}

(async () => {
  await drop("write");
  await drop("none");
  await twice("localhost");
  await twice("127.0.0.1");
})();
