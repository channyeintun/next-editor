// A connection between two sockets, as TCP carries it: a reader that stops
// holds its writer back, large writes arrive in pieces, a server over
// maxConnections closes the newcomer cleanly, a second connect() fails the
// socket, a server reads a clean end from a client whose process is gone, and
// an unref'd socket (an idle keep-alive one too) lets the process exit.
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");

function step(name, body) {
  return new Promise((resolve) => body((line) => console.log(`${name}: ${line}`), resolve));
}

async function main() {
  await step("paused reader", (say, done) => {
    const server = net.createServer((socket) => {
      socket.pause();
      socket.on("error", () => {});
      setTimeout(() => {
        const held = socket.readableLength;
        say(
          `reader holds no more than 4 high water marks: ${held <= socket.readableHighWaterMark * 4}`,
        );
        let received = 0;
        socket.on("data", (chunk) => (received += chunk.length));
        socket.on("end", () => {
          say(`after resume the reader got every byte: ${received === 8 * 1024 * 1024}`);
          server.close(() => done());
        });
        socket.resume();
      }, 300);
    });
    server.listen(0, "127.0.0.1", () => {
      const client = net.connect(server.address().port, "127.0.0.1", () => {
        const chunk = Buffer.alloc(65536, 1);
        let refused = 0;
        let drains = 0;
        let written = 0;
        client.on("drain", () => (drains += 1));
        for (let i = 0; i < 128; i += 1) {
          if (!client.write(chunk, () => (written += 1))) {
            refused += 1;
          }
        }
        setTimeout(() => {
          say(`write() returned false: ${refused > 0}`);
          say(`writes still waiting at 150 ms: ${client.writableLength > 0}`);
          say(`needs drain: ${client.writableNeedDrain}`);
          say(`write callbacks so far fewer than 128: ${written < 128}`);
          client.end();
        }, 150);
        client.on("finish", () =>
          say(`finished after ${drains > 0 ? "a drain" : "no drain"}, ${written} write callbacks`),
        );
      });
      client.on("error", () => {});
      client.resume();
    });
  });

  await step("large write", (say, done) => {
    const server = net.createServer((socket) => {
      let bytes = 0;
      let chunks = 0;
      let largest = 0;
      socket.on("data", (chunk) => {
        bytes += chunk.length;
        chunks += 1;
        largest = Math.max(largest, chunk.length);
      });
      socket.on("end", () => {
        say(
          `${bytes} bytes in several chunks: ${chunks > 1}, none over 64 KiB: ${largest <= 65536}`,
        );
        socket.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const client = net.connect(server.address().port, "127.0.0.1", () => {
        client.end(Buffer.alloc(1000000, 2));
      });
      client.resume();
      client.on("close", () => server.close(() => done()));
    });
  });

  await step("maxConnections", (say, done) => {
    const server = net.createServer((socket) => {
      say("connection");
      socket.resume();
      socket.on("error", () => {});
    });
    server.maxConnections = 1;
    server.on("drop", (data) => say(`drop ${typeof data.remotePort}`));
    server.listen(0, "127.0.0.1", () => {
      const first = net.connect(server.address().port, "127.0.0.1", () => {
        const second = net.connect(server.address().port, "127.0.0.1");
        second.on("error", (error) => say(`second error ${error.code}`));
        second.on("end", () => say("second end"));
        second.on("close", (hadError) => {
          say(`second close ${hadError}`);
          first.destroy();
          server.close(() => done());
        });
        second.resume();
      });
    });
  });

  await step("connect twice", (say, done) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.resume();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const connecting = net.connect(port, "127.0.0.1");
      say(
        `while connecting: returns the socket ${connecting.connect(port, "127.0.0.1") === connecting}`,
      );
      connecting.on("connect", () => say("connect"));
      connecting.on("error", (error) => say(`error ${error.code} ${error.syscall}`));
      connecting.on("close", (hadError) => {
        say(`close ${hadError}`);
        const connected = net.connect(port, "127.0.0.1", () => {
          connected.connect(port, "127.0.0.1");
          say(`once connected: connecting ${connected.connecting} pending ${connected.pending}`);
          connected.write("x", (error) => say(`write callback ${error && error.code}`));
        });
        connected.on("error", (error) => say(`error ${error.code} ${error.syscall}`));
        connected.on("close", (hadError) => {
          say(`close ${hadError}`);
          setTimeout(() => server.close(() => done()), 5);
        });
      });
    });
  });

  await step("client process gone", (say, done) => {
    const events = [];
    let open = 2;
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => events.push(`data ${chunk}`));
      socket.on("end", () => events.push("end"));
      socket.on("error", (error) => events.push(`error ${error.code}`));
      socket.on("close", (hadError) => {
        events.push(`close ${hadError}`);
        open -= 1;
        if (open === 0) {
          say(events.join(", "));
          server.close(() => done());
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const connect = `require("net").connect(${server.address().port}, "127.0.0.1", `;
      // One client exits by itself, its socket unref'd; the next calls process.exit().
      const leaves = `const c = ${connect}() => { c.write("leaves"); c.unref(); });`;
      const exits = `const c = ${connect}() => c.write("exits", () => setTimeout(() => process.exit(0), 20)));`;
      spawn(process.execPath, ["-e", leaves], { stdio: "ignore" }).on("exit", () =>
        spawn(process.execPath, ["-e", exits], { stdio: "ignore" }),
      );
    });
  });

  // Last: nothing but unref'd sockets and servers is left, so the process exits.
  const server = http.createServer((req, res) => res.end("ok"));
  server.listen(0, "127.0.0.1", () => {
    server.unref();
    const port = server.address().port;
    const plain = net.connect(port, "127.0.0.1", () => {
      plain.unref();
      console.log("unref: plain socket connected");
    });
    server.on("connection", (socket) => socket.unref());
    http.get({ port, host: "127.0.0.1" }, (res) => {
      res.resume();
      res.on("end", () => console.log("unref: response read over the keep-alive agent"));
    });
  });
  setTimeout(() => {
    console.log("still running after 3 s");
    process.exit(1);
  }, 3000).unref();
}

process.on("exit", (code) => console.log(`exit ${code}`));
main();
