// @vitest-environment node
// `fetch` to a server inside the runtime: the request goes through our `http`
// client, so headers a browser hides from pages (Cookie, Origin, Set-Cookie)
// still reach the server and the caller, as with Node's fetch.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import http, { type Server } from "../http";
import { createFetch } from "./localFetch";

const RealRequest = globalThis.Request;
const RealResponse = globalThis.Response;
const FORBIDDEN_REQUEST = ["cookie", "origin", "referer", "accept-encoding"];

/** Node's Request and Response do not apply the browser's header guards; these do. */
class GuardedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    for (const name of FORBIDDEN_REQUEST) {
      super.headers.delete(name);
    }
  }
}

class GuardedResponse extends RealResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    super.headers.delete("set-cookie");
  }
}

beforeEach(() => {
  setRuntime(createFakeRuntime());
  globalThis.Request = GuardedRequest as typeof Request;
  globalThis.Response = GuardedResponse as typeof Response;
});

afterEach(() => {
  globalThis.Request = RealRequest;
  globalThis.Response = RealResponse;
  http.globalAgent.destroy();
  setRuntime(null);
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, () => resolve((server.address() as { port: number }).port)),
  );
}

const native = (() => {
  throw new Error("a local request reached the browser's fetch");
}) as unknown as typeof fetch;

describe("fetch to a local server", () => {
  it("sends Cookie, Origin and Referer and exposes Set-Cookie", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("Set-Cookie", ["s=1", "t=2"]);
      res.end(`${req.headers.cookie}|${req.headers.origin}|${req.headers.referer}`);
    });
    const port = await listen(server);
    const fetchLocal = createFetch(native);
    const response = await fetchLocal(`http://localhost:${port}/`, {
      headers: { cookie: "a=1", origin: "http://x.test", referer: "http://x.test/p" },
    });
    expect(response.clone().headers.getSetCookie()).toEqual(["s=1", "t=2"]);
    expect(await response.text()).toBe("a=1|http://x.test|http://x.test/p");
    expect(response.headers.getSetCookie()).toEqual(["s=1", "t=2"]);
    server.close();
  });

  it("keeps the cookie across a same-origin redirect", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/login") {
        res.writeHead(302, { location: "/home" }).end();
      } else {
        res.end(String(req.headers.cookie));
      }
    });
    const port = await listen(server);
    const response = await createFetch(native)(`http://localhost:${port}/login`, {
      headers: [["cookie", "a=1"]],
    });
    expect([response.redirected, await response.text()]).toEqual([true, "a=1"]);
    server.close();
  });
});
