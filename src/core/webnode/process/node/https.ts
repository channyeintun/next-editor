// The `https` builtin. TLS is never terminated inside webnode: a request to
// this machine is plain HTTP to the in-runtime server (whatever `https:` says),
// a request to another host goes through `fetch` with its `https:` URL (the
// browser does the TLS), and `https.createServer` is an `http` server that
// accepts the TLS options and ignores them, so the preview (already HTTPS)
// can reach it.
import { Agent as HttpAgent, type AgentConnectionOptions, type AgentOptions } from "./http/agent";
import { ClientRequest, type RequestOptions } from "./http/client";
import type { IncomingMessage } from "./http/incoming";
import type { ServerResponse } from "./http/response";
import { Server as HttpServer, type HttpServerOptions } from "./http/server";
import { urlToHttpOptions } from "./url";

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
type ResponseListener = (res: IncomingMessage) => void;

const TLS_NAME_OPTIONS = [
  "ca",
  "cert",
  "ciphers",
  "clientCertEngine",
  "crl",
  "dhparam",
  "ecdhCurve",
  "honorCipherOrder",
  "key",
  "passphrase",
  "pfx",
  "rejectUnauthorized",
  "secureOptions",
  "secureProtocol",
  "servername",
  "sessionIdContext",
] as const;

/** `https.Agent`: an `http.Agent` for `https:` (default port 443). */
export class Agent extends HttpAgent {
  maxCachedSessions: number;

  constructor(options?: AgentOptions & { maxCachedSessions?: number }) {
    super(options);
    this.defaultPort = 443;
    this.protocol = "https:";
    this.maxCachedSessions = options?.maxCachedSessions ?? 100;
  }

  /** Node adds the TLS options to the pool key, so differently configured requests never share a socket. */
  override getName(options: AgentConnectionOptions = {}): string {
    let name = super.getName(options);
    name += ":";
    for (const key of TLS_NAME_OPTIONS) {
      const value = options[key];
      if (value !== undefined && value !== null) {
        name += String(value);
      }
      name += ":";
    }
    return name;
  }
}

/** The agent `https.globalAgent` starts as. */
const initialGlobalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });
let currentGlobalAgent: Agent = initialGlobalAgent;

/** `https.request(...)`: `http.request` with `https.globalAgent` as the default agent. */
export function request(
  input: string | URL | RequestOptions,
  options?: RequestOptions | ResponseListener,
  callback?: ResponseListener,
): ClientRequest {
  const args: unknown[] = [input, options, callback];
  let merged: RequestOptions = {};
  if (typeof args[0] === "string") {
    merged = urlToHttpOptions(new URL(args.shift() as string)) as unknown as RequestOptions;
  } else if (args[0] instanceof URL) {
    merged = urlToHttpOptions(args.shift() as URL) as unknown as RequestOptions;
  }
  if (args[0] && typeof args[0] !== "function") {
    Object.assign(merged, args.shift());
  }
  merged._defaultAgent = currentGlobalAgent;
  return new ClientRequest(merged, args[0] as ResponseListener | undefined);
}

/** `https.get(...)`: `request` with the request already ended. */
export function get(
  input: string | URL | RequestOptions,
  options?: RequestOptions | ResponseListener,
  callback?: ResponseListener,
): ClientRequest {
  const req = request(input, options, callback);
  req.end();
  return req;
}

/** `https.Server`: an `http.Server` (TLS options are accepted and not used: webnode does not terminate TLS). */
export class Server extends HttpServer {
  constructor(
    options?: (HttpServerOptions & Record<string, unknown>) | RequestListener,
    listener?: RequestListener,
  ) {
    if (typeof options === "function") {
      super(options);
    } else {
      const httpOptions: HttpServerOptions & Record<string, unknown> = { ...options };
      for (const key of [
        ...TLS_NAME_OPTIONS,
        "ALPNProtocols",
        "SNICallback",
        "requestCert",
        "secureContext",
      ]) {
        delete httpOptions[key];
      }
      super(httpOptions, listener);
    }
  }
}

/** `https.createServer([options][, requestListener])`: plain HTTP; see `Server`. */
export function createServer(
  options?: (HttpServerOptions & Record<string, unknown>) | RequestListener,
  listener?: RequestListener,
): Server {
  return new Server(options, listener);
}

/** What `require("https")` returns. */
const https = {
  Agent,
  globalAgent: initialGlobalAgent,
  Server,
  createServer,
  get,
  request,
};

Object.defineProperty(https, "globalAgent", {
  configurable: true,
  enumerable: true,
  get: () => currentGlobalAgent,
  set: (agent: Agent) => {
    currentGlobalAgent = agent;
  },
});

export { initialGlobalAgent as globalAgent };
export default https;
