const http = require("http");
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json", "X-Custom": "yes" });
      res.end(JSON.stringify({ method: req.method, body, host: typeof req.headers.host }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.write("not ");
    res.end("found");
  });
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log("listening", typeof port, port > 0);
  const request = http.request(
    {
      port,
      host: "127.0.0.1",
      path: "/json",
      method: "POST",
      headers: { "Content-Type": "text/plain" },
    },
    (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        console.log(res.statusCode, res.headers["content-type"], res.headers["x-custom"], data);
        http.get(`http://127.0.0.1:${port}/missing`, (res2) => {
          let text = "";
          res2.on("data", (chunk) => (text += chunk));
          res2.on("end", () => {
            console.log(res2.statusCode, text, res2.headers["transfer-encoding"]);
            fetch(`http://127.0.0.1:${port}/json`)
              .then((response) => response.json())
              .then((json) => {
                console.log("fetch", json.method);
                server.close(() => {
                  console.log("closed");
                  endCallbacks();
                });
              });
          });
        });
      });
    },
  );
  request.end("payload");
});

// A callback given to end() is called with null before the 'finish'
// listeners, or with the error the last write ended with; one given after
// the end is queued with the first, and one given after 'finish' gets
// ERR_STREAM_ALREADY_FINISHED.
function endCallbacks() {
  const out = [];
  const show =
    (label) =>
    (...args) =>
      out.push(
        `${label}: ${args.length} ${args.map((a) => (a instanceof Error ? a.code : String(a)))}`,
      );
  const refused = http.request({ port: 1, host: "127.0.0.1", method: "POST" });
  refused.on("error", (e) => out.push(`refused error ${e.code}`));
  refused.on("finish", show("refused finish"));
  refused.end("q", show("refused end"));
  refused.on("close", () => {
    refused.end(show("refused end after close"));
    setTimeout(answered, 20);
  });
  function answered() {
    const server2 = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/plain") {
        res.on("finish", () => out.push(`plain finish ${res.writableFinished}`));
        res.end(show("plain res.end(cb)"));
        out.push(`plain after end ${res.writableFinished} ${res.writableEnded}`);
        return;
      }
      res.on("finish", show("res finish"));
      res.end("body", show("res.end(chunk, cb)"));
      res.end(show("res.end again"));
      res.on("finish", () => setTimeout(() => res.end(show("res.end after finish")), 5));
      res.on("error", (e) => out.push(`res error ${e.code}`));
      res.end("more", show("res.end(chunk) after end"));
    });
    server2.listen(0, "127.0.0.1", () => {
      const { port } = server2.address();
      const req = http.request({ port, host: "127.0.0.1", method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => {
          const plain = http.get({ port, host: "127.0.0.1", path: "/plain" }, (res2) => {
            res2.resume();
            res2.on("end", () => {
              server2.close();
              setTimeout(() => console.log(out.join("\n")), 50);
            });
          });
          plain.on("finish", () => out.push(`plain request finish ${plain.writableFinished}`));
        });
      });
      req.on("finish", show("req finish"));
      req.end("data", show("req.end(chunk, cb)"));
      out.push(`req after end ${req.writableFinished}`);
    });
  }
}
