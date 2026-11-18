// @vitest-environment node
// The `dns` and `dns/promises` builtins: only this machine's names resolve.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime } from "../testing/fakeRuntime";
import dns from "./dns";
import dnsPromises from "./dns_promises";
import { runMacrotask } from "./eventLoop";
import { createProcess } from "./process";

type Lookup = (
  hostname: string,
  options: unknown,
  callback?: (error: Error | null, address?: unknown, family?: number) => void,
) => object;

const lookup = dns.lookup as Lookup;

function lookupAsync(
  hostname: string,
  options?: unknown,
): Promise<[Error | null, unknown, number?]> {
  return new Promise((resolve) => {
    lookup(hostname, options ?? {}, (error, address, family) => resolve([error, address, family]));
  });
}

const NODE_22_KEYS = [
  "lookup",
  "lookupService",
  "Resolver",
  "getDefaultResultOrder",
  "setDefaultResultOrder",
  "setServers",
  "ADDRCONFIG",
  "ALL",
  "V4MAPPED",
  "NODATA",
  "FORMERR",
  "SERVFAIL",
  "NOTFOUND",
  "NOTIMP",
  "REFUSED",
  "BADQUERY",
  "BADNAME",
  "BADFAMILY",
  "BADRESP",
  "CONNREFUSED",
  "TIMEOUT",
  "EOF",
  "FILE",
  "NOMEM",
  "DESTRUCTION",
  "BADSTR",
  "BADFLAGS",
  "NONAME",
  "BADHINTS",
  "NOTINITIALIZED",
  "LOADIPHLPAPI",
  "ADDRGETNETWORKPARAMS",
  "CANCELLED",
  "getServers",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
  "promises",
];

describe("dns", () => {
  it("has Node 22's exports", () => {
    expect(Object.keys(dns)).toEqual(NODE_22_KEYS);
    expect(Object.keys(dnsPromises).sort()).toEqual(
      NODE_22_KEYS.filter(
        (key) => !["ADDRCONFIG", "ALL", "V4MAPPED", "promises"].includes(key),
      ).sort(),
    );
    expect(dns.promises).toBe(dnsPromises);
    expect(dns.NOTFOUND).toBe("ENOTFOUND");
    expect(dns.ADDRCONFIG).toBe(32);
  });

  it("resolves localhost and the hostname to the loopback address", async () => {
    expect(await lookupAsync("localhost")).toEqual([null, "127.0.0.1", 4]);
    expect(await lookupAsync("localhost", { family: 6 })).toEqual([null, "::1", 6]);
    expect(await lookupAsync("localhost", 4)).toEqual([null, "127.0.0.1", 4]);
    expect(await lookupAsync("localhost", { all: true })).toEqual([
      null,
      [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ],
      undefined,
    ]);
    expect(await lookupAsync("localhost", { all: true, order: "ipv6first" })).toEqual([
      null,
      [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ],
      undefined,
    ]);
  });

  it("returns IP literals as given", async () => {
    expect(await lookupAsync("10.1.2.3")).toEqual([null, "10.1.2.3", 4]);
    expect(await lookupAsync("::ffff:1.2.3.4")).toEqual([null, "::ffff:1.2.3.4", 6]);
  });

  it("fails other names with ENOTFOUND, asynchronously", async () => {
    let sync = true;
    const pending = lookupAsync("example.com");
    sync = false;
    const [error] = await pending;
    expect(sync).toBe(false);
    expect(error).toMatchObject({
      message: "getaddrinfo ENOTFOUND example.com",
      code: "ENOTFOUND",
      errno: -3008,
      syscall: "getaddrinfo",
      hostname: "example.com",
    });
  });

  it("validates arguments as Node does", () => {
    expect(() => lookup(1 as unknown as string, () => {})).toThrow(
      'The "hostname" argument must be of type string. Received type number (1)',
    );
    expect(() => lookup("x", { family: 5 }, () => {})).toThrow(
      "The property 'options.family' must be one of: 0, 4, 6. Received 5",
    );
    expect(() => dns.setDefaultResultOrder("x" as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => dns.setServers(["nope"])).toThrow("Invalid IP address: nope");
  });

  it("takes only getaddrinfo's flags as lookup hints, as Node does", async () => {
    const message = (hints: unknown) => {
      try {
        lookup("localhost", { hints }, () => {});
      } catch (error) {
        return `${(error as { code?: string }).code}: ${(error as Error).message}`;
      }
      return "ok";
    };
    const text = (received: number) => `The argument 'hints' is invalid. Received ${received}`;
    const invalid = (received: number) => `ERR_INVALID_ARG_VALUE: ${text(received)}`;
    for (const hints of [
      undefined,
      null,
      0,
      dns.ADDRCONFIG,
      dns.V4MAPPED,
      dns.ALL,
      dns.ADDRCONFIG | dns.V4MAPPED | dns.ALL,
    ]) {
      expect(message(hints)).toBe("ok");
    }
    expect(message(123456)).toBe(invalid(123456));
    expect(message(3)).toBe(invalid(3));
    // The number is read as Node reads it: an unsigned 32-bit integer.
    expect(message(-1)).toBe(invalid(4294967295));
    expect(message(1.5)).toBe(invalid(1));
    expect(message("1")).toBe(
      "ERR_INVALID_ARG_TYPE: The \"options.hints\" property must be of type number. Received type string ('1')",
    );
    // The hints are checked before the family.
    expect(() => lookup("localhost", { hints: 3, family: 9 }, () => {})).toThrow(text(3));
    // dns.promises throws at the call, as Node's does.
    expect(() => dnsPromises.lookup("localhost", { hints: 3 })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
  });

  it("keeps the result order and server list", () => {
    expect(dns.getDefaultResultOrder()).toBe("verbatim");
    dns.setDefaultResultOrder("ipv4first");
    expect(dns.getDefaultResultOrder()).toBe("ipv4first");
    dns.setDefaultResultOrder("verbatim");
    dns.setServers(["1.1.1.1", "[::1]:53"]);
    expect(dns.getServers()).toEqual(["1.1.1.1", "[::1]:53"]);
  });

  it("answers lookupService for the loopback address", async () => {
    const result = await new Promise((resolve) => {
      dns.lookupService("127.0.0.1", 80, (error, hostname, service) =>
        resolve([error, hostname, service]),
      );
    });
    expect(result).toEqual([null, "localhost", "http"]);
    await expect(dnsPromises.lookupService("10.0.0.1", 22)).rejects.toMatchObject({
      code: "ENOTFOUND",
      syscall: "getnameinfo",
    });
  });

  it("fails DNS queries the way an unreachable resolver does", async () => {
    const error = await new Promise((resolve) => {
      dns.resolve4("example.com", (failure) => resolve(failure));
    });
    expect(error).toMatchObject({
      message: "queryA ENOTFOUND example.com",
      code: "ENOTFOUND",
      syscall: "queryA",
      hostname: "example.com",
    });
    const mx = await new Promise((resolve) => dns.resolve("example.com", "MX", resolve));
    expect(mx).toMatchObject({ syscall: "queryMx" });
    const reverse = await new Promise((resolve) => dns.reverse("1.2.3.4", resolve));
    expect(reverse).toMatchObject({ syscall: "getHostByAddr", code: "ENOTFOUND" });
    expect(() => dns.resolve("example.com", "BOGUS", () => {})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8"]);
    expect(resolver.getServers()).toEqual(["8.8.8.8"]);
  });

  it("dns/promises resolves the same names", async () => {
    expect(await dnsPromises.lookup("localhost")).toEqual({ address: "127.0.0.1", family: 4 });
    expect(await dnsPromises.lookup("::1")).toEqual({ address: "::1", family: 6 });
    expect(await dnsPromises.lookup("localhost", { all: true, family: 4 })).toEqual([
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(dnsPromises.lookup("nope.invalid")).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(dnsPromises.resolveTxt("example.com")).rejects.toMatchObject({
      syscall: "queryTxt",
    });
    const resolver = new dnsPromises.Resolver();
    await expect(resolver.resolve6("example.com")).rejects.toMatchObject({ syscall: "queryAaaa" });
  });
});

// Each order below is what real Node v26 prints for the same program: a
// callback logs itself, then queues a tick (">t") and a promise job (">p").
describe("when the answers come, as Node's", () => {
  const order: string[] = [];
  let proc: ReturnType<typeof createProcess>;
  let fake: ReturnType<typeof createFakeRuntime>;

  function start(): void {
    fake = createFakeRuntime();
    setRuntime(fake);
    proc = createProcess({ loadBuiltin: () => undefined, ipc: null });
    order.length = 0;
  }

  afterEach(() => {
    setRuntime(null);
  });

  function mark(tag: string): void {
    order.push(tag);
    proc.nextTick(() => order.push(`${tag}>t`));
    void Promise.resolve().then(() => order.push(`${tag}>p`));
  }

  function callerQueues(): void {
    proc.nextTick(() => order.push("caller>t"));
    void Promise.resolve().then(() => order.push("caller>p"));
  }

  async function until(count: number): Promise<void> {
    for (let i = 0; i < 100 && order.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it("answers a lookup by name from the event loop, holding the process meanwhile", async () => {
    start();
    let held = 0;
    runMacrotask(() => {
      lookup("localhost", {}, () => mark("lookup"));
      held = fake.refCount;
      callerQueues();
    });
    await until(5);
    expect(order).toEqual(["caller>t", "caller>p", "lookup", "lookup>t", "lookup>p"]);
    expect([held, fake.refCount]).toEqual([1, 0]);
  });

  it("answers a lookup of an address from a tick, in its own family whatever was asked", async () => {
    start();
    const answers: unknown[] = [];
    runMacrotask(() => {
      lookup("127.0.0.1", {}, () => mark("ip"));
      callerQueues();
      lookup("127.0.0.1", { family: 6 }, (error, address, family) =>
        answers.push([error, address, family]),
      );
      lookup("::1", { family: 4, all: true }, (error, address) => answers.push([error, address]));
    });
    await until(5);
    expect(order).toEqual(["ip", "caller>t", "ip>t", "caller>p", "ip>p"]);
    expect(answers).toEqual([
      [null, "127.0.0.1", 4],
      [null, [{ address: "::1", family: 6 }]],
    ]);
  });

  it("answers lookupService and the queries from the event loop", async () => {
    start();
    runMacrotask(() => {
      dns.lookupService("127.0.0.1", 80, (_error, hostname, service) =>
        mark(`service ${hostname} ${service}`),
      );
      callerQueues();
    });
    await until(5);
    expect(order).toEqual([
      "caller>t",
      "caller>p",
      "service localhost http",
      "service localhost http>t",
      "service localhost http>p",
    ]);
    order.length = 0;
    runMacrotask(() => {
      dns.resolve4("example.com", (error) =>
        mark(`resolve4 ${(error as { code?: string } | null)?.code}`),
      );
      callerQueues();
    });
    await until(5);
    expect(order.slice(0, 3)).toEqual(["caller>t", "caller>p", "resolve4 ENOTFOUND"]);
  });

  it("settles dns.promises.lookup of a name from the event loop", async () => {
    start();
    runMacrotask(() => {
      void dnsPromises.lookup("localhost").then(() => mark("lookup"));
      callerQueues();
    });
    await until(5);
    // In a promise job a tick runs after the promise jobs queued with it.
    expect(order).toEqual(["caller>t", "caller>p", "lookup", "lookup>p", "lookup>t"]);
  });

  it("throws for a hostname that is empty, as Node 26 does, after checking the callback", async () => {
    start();
    for (const hostname of ["", null, undefined, false, 0]) {
      expect(() => lookup(hostname as string, {}, () => {})).toThrow(
        expect.objectContaining({
          code: "ERR_INVALID_ARG_VALUE",
          message: `The argument 'hostname' must be a non-empty string. Received ${hostname === "" ? "''" : String(hostname)}`,
        }),
      );
    }
    expect(() => lookup("", 5 as unknown as object)).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: 'The "callback" argument must be of type function. Received undefined',
      }),
    );
    await expect(dnsPromises.lookup("")).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  });

  it("checks lookupService's address, then its port, then its callback, as Node does", () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return "ok";
    };
    const lookupService = dns.lookupService as (...args: unknown[]) => object;
    expect(code(() => lookupService("x", 80, 5))).toBe("ERR_INVALID_ARG_VALUE");
    expect(code(() => lookupService("127.0.0.1", 99999, 5))).toBe("ERR_SOCKET_BAD_PORT");
    expect(code(() => lookupService("127.0.0.1", 80, 5))).toBe("ERR_INVALID_ARG_TYPE");
  });
});
