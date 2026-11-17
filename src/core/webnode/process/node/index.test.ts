// @vitest-environment node
// The builtin registry: every name `module.builtinModules` lists loads, except
// the few the README names as not available.
import { describe, expect, it } from "vitest";
import http from "./http";
import { loadBuiltin } from "./index";
import { BUILTIN_MODULE_NAMES } from "./names";

/** Listed by Node and by webnode, but not available (README, "Not supported"). */
const UNAVAILABLE = new Set(["_stream_wrap", "_tls_common", "_tls_wrap"]);

describe("builtin registry", () => {
  it("loads every listed builtin but the unavailable ones", () => {
    const outcome = (name: string) => {
      try {
        loadBuiltin(name);
        return "loads";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const outcomes = BUILTIN_MODULE_NAMES.map((name) => [name, outcome(name)]);
    expect(outcomes).toEqual(
      BUILTIN_MODULE_NAMES.map((name) => [
        name,
        UNAVAILABLE.has(name)
          ? `The builtin module "${name}" is not available in webnode`
          : "loads",
      ]),
    );
  });

  it("gives the private _http_ modules http's own classes", () => {
    const agent = loadBuiltin("_http_agent") as { Agent: unknown; globalAgent: unknown };
    expect(agent.Agent).toBe(http.Agent);
    expect(agent.globalAgent).toBe(http.globalAgent);
    expect((loadBuiltin("_http_server") as { Server: unknown }).Server).toBe(http.Server);
    expect((loadBuiltin("_http_incoming") as { IncomingMessage: unknown }).IncomingMessage).toBe(
      http.IncomingMessage,
    );
    expect(loadBuiltin("_http_common")).toMatchObject({ CRLF: "\r\n" });
    expect(loadBuiltin("_http_agent")).toBe(loadBuiltin("_http_agent"));
  });
});
