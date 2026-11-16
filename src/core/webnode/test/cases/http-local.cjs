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
                server.close(() => console.log("closed"));
              });
          });
        });
      });
    },
  );
  request.end("payload");
});
