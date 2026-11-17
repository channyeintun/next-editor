// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { readText, setupRuntime } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface Seen {
  head: string;
  body: string;
}

/**
 * Starts a local HTTP server on `port` in the fake runtime. `reply` gets the
 * request and returns the raw response, or null to never answer.
 */
function serve(
  rt: ReturnType<typeof setupRuntime>["rt"],
  port: number,
  reply: (seen: Seen, index: number) => string | null,
): { requests: Seen[]; close(): void } {
  const requests: Seen[] = [];
  const server = rt.net.listen(port, "127.0.0.1", (channel) => {
    let raw = "";
    channel.onData = (chunk) => {
      raw += decoder.decode(chunk);
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const head = raw.slice(0, end);
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
      if (raw.length < end + 4 + length) {
        return;
      }
      const seen = { head, body: raw.slice(end + 4, end + 4 + length) };
      requests.push(seen);
      const response = reply(seen, requests.length - 1);
      if (response !== null) {
        channel.write(encoder.encode(response));
        channel.end();
      }
    };
  });
  return { requests, close: () => server.close() };
}

function ok(body: string, extra = ""): string {
  return `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n${extra}\r\n${body}`;
}

async function run(script: string, setup: (rt: ReturnType<typeof setupRuntime>["rt"]) => void) {
  const { rt, vfs } = setupRuntime({});
  rt.feedStdin(null);
  setup(rt);
  const status = await runShell(["sh", "-c", script]);
  return { status, out: rt.stdout(), err: rt.stderr(), vfs };
}

describe("curl options", () => {
  it("-m / --max-time ends a request that never answers with exit 28", async () => {
    let server: { close(): void } | undefined;
    const result = await run(
      "curl -s -m 0.2 localhost:3000; echo $?; curl -sS --max-time 0.2 localhost:3000",
      (rt) => {
        server = serve(rt, 3000, () => null);
      },
    );
    server?.close();
    expect(result.out).toBe("28\n");
    expect(result.err).toMatch(
      /^curl: \(28\) Operation timed out after \d+ milliseconds with 0 bytes received\n$/,
    );
  });

  it("--retry tries again after a transient status, and accepts --connect-timeout", async () => {
    let server: { requests: Seen[]; close(): void } | undefined;
    const result = await run(
      'curl -fsS --retry 2 --retry-delay 0 --connect-timeout 5 localhost:3000/health; echo " $?"',
      (rt) => {
        server = serve(rt, 3000, (_, index) =>
          index === 0 ? "HTTP/1.1 503 Busy\r\nContent-Length: 0\r\n\r\n" : ok("up"),
        );
      },
    );
    server?.close();
    expect(result.out).toBe("up 0\n");
    expect(server?.requests.length).toBe(2);
    expect(result.err).toBe("");
  }, 10000);

  it("--retry does not retry a refused connection without --retry-connrefused", async () => {
    const result = await run("curl -s --retry 3 localhost:3001; echo $?", () => {});
    expect(result.out).toBe("7\n");
    expect(result.err).toBe("");
  });

  it("rejects a bad number as curl does", async () => {
    const result = await run("curl --retry x localhost:1", () => {});
    expect(result.status).toBe(2);
    expect(result.err).toBe("curl: (2) option --retry: expected a proper numerical parameter\n");
  });

  it("-G and --data-urlencode put the data in the query", async () => {
    let server: { requests: Seen[]; close(): void } | undefined;
    const result = await run(
      "curl -s -G -d a=1 --data-urlencode 'q=x y&z' -w '%{url_effective}' localhost:3000/p",
      (rt) => {
        server = serve(rt, 3000, () => ok(""));
      },
    );
    server?.close();
    expect(server?.requests[0].head.split("\r\n")[0]).toBe("GET /p?a=1&q=x+y%26z HTTP/1.1");
    expect(result.out).toBe("http://localhost:3000/p?a=1&q=x+y%26z");
  });

  it("-F sends multipart form data with files", async () => {
    let server: { requests: Seen[]; close(): void } | undefined;
    const result = await run(
      "echo hi > f.txt; curl -s -F name=x -F 'up=@f.txt;type=text/plain' localhost:3000",
      (rt) => {
        server = serve(rt, 3000, () => ok("ok"));
      },
    );
    server?.close();
    expect(result.out).toBe("ok");
    const seen = server?.requests[0] as Seen;
    const boundary = /boundary=(\S+)/.exec(seen.head)?.[1];
    expect(seen.head.split("\r\n")[0]).toBe("POST / HTTP/1.1");
    expect(seen.body).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nx\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="up"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\nhi\n\r\n` +
        `--${boundary}--\r\n`,
    );
  });

  it("-b sends cookies and -c saves the ones the server sets", async () => {
    let server: { requests: Seen[]; close(): void } | undefined;
    const result = await run(
      "curl -s -b 'a=1' -c jar localhost:3000 >/dev/null; curl -s -b jar localhost:3000",
      (rt) => {
        server = serve(rt, 3000, () => ok("x", "Set-Cookie: sid=abc; Path=/\r\n"));
      },
    );
    server?.close();
    expect(server?.requests[0].head).toContain("\r\nCookie: a=1");
    expect(server?.requests[1].head).toContain("\r\nCookie: a=1; sid=abc");
    expect(readText(result.vfs, "/work/jar")).toContain(
      "localhost\tFALSE\t/\tFALSE\t0\tsid\tabc\n",
    );
  });

  it("-w knows curl's usual variables, also after a failed connection", async () => {
    let server: { close(): void } | undefined;
    const result = await run(
      "curl -s -o /dev/null -w '%{http_code} %{size_download} %{content_type} %{num_redirects} %{method} %{exitcode}\\n' localhost:3000; curl -s -o /dev/null -w '%{http_code}|%{exitcode}|%{time_total}|%{nope}\\n' localhost:3001",
      (rt) => {
        server = serve(rt, 3000, () => ok("hello"));
      },
    );
    server?.close();
    expect(result.out).toMatch(/^200 5 text\/plain 0 GET 0\n000\|7\|\d+\.\d{6}\|\n$/);
    expect(result.err).toBe("curl: unknown --write-out variable: 'nope'\n");
  });
});
