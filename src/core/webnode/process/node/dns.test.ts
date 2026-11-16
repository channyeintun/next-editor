// @vitest-environment node
// The `dns` and `dns/promises` builtins: only this machine's names resolve.
import { describe, expect, it } from "vitest";
import dns from "./dns";
import dnsPromises from "./dns_promises";

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
