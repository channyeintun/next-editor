// When net and http run their callbacks, beyond what nexttick-sources.cjs
// covers: socket and http timeouts, listening on an address, a socket given an
// aborted signal, and http's own deferrals (a request's socket, the response
// callback, a keep-alive socket set free, a response's 'finish' and 'close',
// write after end, the cork a write puts on the socket). Each callback logs
// itself, then queues a tick (">t") and a promise job (">p"): Node runs the
// tick first.
"use strict";
const http = require("http");
const net = require("net");

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

/** What the caller queues after starting something, in the same callback. */
function callerQueues() {
  process.nextTick(() => log("caller>t"));
  Promise.resolve().then(() => log("caller>p"));
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

/** An http server on 127.0.0.1; `ready` gets it and its port. */
function serve(options, handler, ready) {
  const server = http.createServer(options, handler);
  server.listen(0, "127.0.0.1", () => ready(server, server.address().port));
}

function shut(server, done) {
  server.closeAllConnections();
  server.close(() => done());
}

scenario("socket idle timeout", (done) => {
  const server = net.createServer((socket) => {
    socket.resume();
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    client.setTimeout(30);
    client.on("timeout", () => {
      mark("timeout");
      client.destroy();
    });
    client.on("close", () => server.close(() => done()));
  });
});

scenario("throw in a 'timeout' listener", (done) => {
  const server = net.createServer((socket) => {
    socket.resume();
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    process.once("uncaughtException", (error) => mark(`uncaught ${error.message}`));
    client.setTimeout(30, () => {
      mark("timeout");
      client.destroy();
      throw new Error("from the listener");
    });
    client.on("close", () => server.close(() => done()));
  });
});

scenario("http headersTimeout", (done) => {
  const options = { headersTimeout: 60, requestTimeout: 0, connectionsCheckingInterval: 20 };
  serve(
    options,
    () => log("request"),
    (server, port) => {
      server.on("clientError", (error, socket) => {
        mark(`clientError ${error.code}`);
        socket.destroy();
      });
      const client = net.connect(port, "127.0.0.1", () =>
        client.write("GET / HTTP/1.1\r\nHost: x\r\n"),
      );
      client.on("error", () => {});
      client.on("close", () => server.close(() => done()));
    },
  );
});

scenario("http server.setTimeout", (done) => {
  serve(
    {},
    () => {},
    (server, port) => {
      server.setTimeout(40, (socket) => {
        mark("server timeout");
        socket.destroy();
      });
      const request = http.get({ port, host: "127.0.0.1", agent: false });
      request.on("error", () => {});
      request.on("close", () => server.close(() => done()));
    },
  );
});

scenario("http keepAliveTimeout", (done) => {
  serve(
    {},
    (req, res) => res.end("ok"),
    (server, port) => {
      server.keepAliveTimeout = 40;
      server.on("connection", (socket) => socket.on("timeout", () => mark("socket timeout")));
      const client = net.connect(port, "127.0.0.1", () =>
        client.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      client.resume();
      client.on("close", () => server.close(() => done()));
    },
  );
});

scenario("http client timeout", (done) => {
  serve(
    {},
    () => {},
    (server, port) => {
      const request = http.get({ port, host: "127.0.0.1", agent: false });
      request.setTimeout(40, () => {
        mark("request timeout");
        setTimeout(() => request.destroy(), 5);
      });
      request.on("error", () => {});
      request.on("close", () => shut(server, done));
    },
  );
});

scenario("listen on an address, then one await", (done) => {
  (async () => {
    const byAddress = net.createServer().listen(0, "127.0.0.1");
    const byName = net.createServer().listen(0, "localhost");
    await Promise.resolve();
    log(`by address: listening ${byAddress.listening} ${byAddress.address()?.address}`);
    log(`by name: listening ${byName.listening}`);
    byName.on("listening", () => {
      log("by name: listening later");
      byAddress.close();
      byName.close(() => done());
    });
  })();
});

scenario("listen on an address and the caller", (done) => {
  setTimeout(() => {
    const server = net.createServer();
    server.on("listening", () => mark("listening"));
    server.listen(0, "127.0.0.1", () => {
      mark("callback");
      server.close(() => {
        mark("closed");
        setTimeout(done, 5);
      });
    });
    callerQueues();
  }, 1);
});

scenario("EADDRINUSE on an address", (done) => {
  const first = net.createServer().listen(0, "127.0.0.1", () => {
    setTimeout(() => {
      const second = net.createServer();
      second.on("error", (error) => {
        mark(`error ${error.code} ${error.address}`);
        first.close(() => setTimeout(done, 5));
      });
      second.listen(first.address().port, "127.0.0.1");
      callerQueues();
    }, 1);
  });
});

scenario("socket given an aborted signal", (done) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
  });
  server.listen(0, "127.0.0.1", () => {
    const controller = new AbortController();
    controller.abort();
    const client = net.connect({
      port: server.address().port,
      host: "127.0.0.1",
      signal: controller.signal,
    });
    log(`destroyed ${client.destroyed}`);
    client.on("error", (error) => mark(`error ${error.name}`));
    client.on("close", (hadError) => log(`close ${hadError}`));
    // Node still connects such a socket.
    client.on("connect", () => {
      log("connect");
      client.destroy();
      server.close(() => setTimeout(done, 5));
    });
    callerQueues();
  });
});

scenario("http request's socket and the caller", (done) => {
  serve(
    {},
    (req, res) => res.end("x"),
    (server, port) => {
      setTimeout(() => {
        const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
        request.on("socket", () => mark("socket"));
        request.on("close", () => shut(server, done));
        callerQueues();
      }, 1);
    },
  );
});

scenario("http response callback", (done) => {
  serve(
    {},
    (req, res) => {
      mark("s:request");
      res.end("x");
    },
    (server, port) => {
      const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => {
        mark("c:response");
        res.on("data", () => mark("c:data"));
        res.on("end", () => mark("c:end"));
      });
      request.on("close", () => setTimeout(() => shut(server, done), 20));
    },
  );
});

scenario("http keep-alive socket set free", (done) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  serve(
    {},
    (req, res) => res.end(req.url),
    (server, port) => {
      const get = (path, then) => {
        const request = http.get({ port, host: "127.0.0.1", agent, path }, (res) => {
          res.resume();
          res.on("end", () => mark(`end ${path}`));
        });
        request.on("socket", (socket) => {
          if (socket.listenerCount("free") === 1) {
            socket.on("free", () => log("free"));
          }
        });
        request.on("close", () => {
          mark(`close ${path}`);
          then();
        });
      };
      get("/1", () =>
        get("/2", () =>
          setTimeout(() => {
            agent.destroy();
            shut(server, done);
          }, 5),
        ),
      );
    },
  );
});

scenario("http response 'finish' and 'close'", (done) => {
  serve(
    {},
    (req, res) => {
      res.on("finish", () => mark("finish"));
      res.on("close", () => mark("close"));
      res.end("x");
    },
    (server, port) => {
      const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
      request.on("close", () => setTimeout(() => shut(server, done), 5));
    },
  );
});

scenario("http end() after the body was flushed", (done) => {
  serve(
    {},
    (req, res) => {
      res.writeHead(200, { "Content-Length": "1" });
      res.write("x");
      setTimeout(() => {
        res.on("finish", () => mark("finish"));
        res.end();
        callerQueues();
      }, 10);
    },
    (server, port) => {
      const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
      request.on("close", () => setTimeout(() => shut(server, done), 5));
    },
  );
});

scenario("http write corks the socket for one tick", (done) => {
  serve(
    {},
    (req, res) => {
      res.writeHead(200, { "Content-Length": "2" });
      res.write("a");
      log(`corked ${res.socket.writableCorked}`);
      process.nextTick(() => {
        log(`a tick later: corked ${res.socket.writableCorked}`);
        res.end("b");
      });
    },
    (server, port) => {
      const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
      request.on("close", () => setTimeout(() => shut(server, done), 5));
    },
  );
});

scenario("http write after end", (done) => {
  serve(
    {},
    (req, res) => {
      res.on("error", (error) => mark(`error ${error.code}`));
      res.end("x");
      log(`write returned ${res.write("late", (error) => mark(`callback ${error.code}`))}`);
      callerQueues();
    },
    (server, port) => {
      const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
      request.on("close", () => setTimeout(() => shut(server, done), 5));
    },
  );
});

next();
