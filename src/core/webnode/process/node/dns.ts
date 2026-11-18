// The `dns` builtin. A browser cannot resolve names, so only this machine's
// names resolve: `localhost` and the runtime's hostname give the loopback
// address, and an IP literal is returned as given. Any other name fails with
// `ENOTFOUND`, and the DNS queries (`resolve*`, `reverse`) fail the way they
// do with no reachable DNS server. `dns/promises` (dns_promises.ts) shares the
// same rules through `lookupAddresses` and `queryError`.
//
// The answers come when Node's do. An argument error is thrown at once. A
// lookup of an IP literal is answered from a tick. A lookup by name,
// lookupService and the queries are answered from the event loop, as
// getaddrinfo's and c-ares's are (fs/completion `complete`), and hold the
// process until then.
import { complete } from "./fs/completion";
import {
  invalidArgType,
  invalidArgValue,
  makeNodeError,
  validateFunction,
  validateString,
} from "./internalErrors";
import { isIP, isLocalHost, validatePort } from "./net/ip";
import { nextTick } from "./eventLoop";

/** One address `lookup` reports. */
export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

/** `dns.lookup` options. */
export interface LookupOptions {
  family?: number | "IPv4" | "IPv6";
  hints?: number;
  all?: boolean;
  verbatim?: boolean;
  order?: "ipv4first" | "ipv6first" | "verbatim";
}

type ResultOrder = "ipv4first" | "ipv6first" | "verbatim";

/** `dns.ADDRCONFIG` and friends: the Linux `getaddrinfo` flags. */
export const ADDRCONFIG = 32;
export const ALL = 16;
export const V4MAPPED = 8;

/** The error codes `dns` reports. */
export const NODATA = "ENODATA";
export const FORMERR = "EFORMERR";
export const SERVFAIL = "ESERVFAIL";
export const NOTFOUND = "ENOTFOUND";
export const NOTIMP = "ENOTIMP";
export const REFUSED = "EREFUSED";
export const BADQUERY = "EBADQUERY";
export const BADNAME = "EBADNAME";
export const BADFAMILY = "EBADFAMILY";
export const BADRESP = "EBADRESP";
export const CONNREFUSED = "ECONNREFUSED";
export const TIMEOUT = "ETIMEOUT";
export const EOF = "EOF";
export const FILE = "EFILE";
export const NOMEM = "ENOMEM";
export const DESTRUCTION = "EDESTRUCTION";
export const BADSTR = "EBADSTR";
export const BADFLAGS = "EBADFLAGS";
export const NONAME = "ENONAME";
export const BADHINTS = "EBADHINTS";
export const NOTINITIALIZED = "ENOTINITIALIZED";
export const LOADIPHLPAPI = "ELOADIPHLPAPI";
export const ADDRGETNETWORKPARAMS = "EADDRGETNETWORKPARAMS";
export const CANCELLED = "ECANCELLED";

const ERROR_CODES = {
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED,
};

let defaultResultOrder: ResultOrder = "verbatim";

/** `dns.getDefaultResultOrder()`. */
export function getDefaultResultOrder(): ResultOrder {
  return defaultResultOrder;
}

/** `dns.setDefaultResultOrder(order)`. */
export function setDefaultResultOrder(order: ResultOrder): void {
  if (order !== "ipv4first" && order !== "ipv6first" && order !== "verbatim") {
    throw invalidArgValue(
      "dnsOrder",
      order,
      "must be one of: 'verbatim', 'ipv4first', 'ipv6first'",
    );
  }
  defaultResultOrder = order;
}

/** `getaddrinfo ENOTFOUND name`: what Node reports for a name it cannot resolve. */
export function notFoundError(hostname: string, syscall = "getaddrinfo"): Error {
  const error = new Error(`${syscall} ENOTFOUND ${hostname}`) as Error & Record<string, unknown>;
  error.errno = -3008;
  error.code = "ENOTFOUND";
  error.syscall = syscall;
  error.hostname = hostname;
  return error;
}

/** The failure of a DNS query (`queryA`, `getHostByAddr`, ...): no resolver is reachable. */
export function queryError(syscall: string, hostname: string): Error {
  const error = new Error(`${syscall} ${NOTFOUND} ${hostname}`) as Error & Record<string, unknown>;
  error.code = NOTFOUND;
  error.syscall = syscall;
  error.hostname = hostname;
  return error;
}

function validateFamily(family: unknown): 0 | 4 | 6 {
  if (family === undefined || family === null || family === 0) {
    return 0;
  }
  if (family === 4 || family === "IPv4") {
    return 4;
  }
  if (family === 6 || family === "IPv6") {
    return 6;
  }
  if (typeof family !== "number" && typeof family !== "string") {
    throw invalidArgType("options.family", ["number", "string"], family);
  }
  throw invalidArgValue("options.family", family, "must be one of: 0, 4, 6");
}

/** Normalised `lookup` options: the family, `all`, and the result order. */
export function normalizeLookupOptions(options: unknown): {
  family: 0 | 4 | 6;
  all: boolean;
  order: ResultOrder;
} {
  if (typeof options === "number" || typeof options === "string") {
    return { family: validateFamily(options), all: false, order: defaultResultOrder };
  }
  if (options === undefined || options === null) {
    return { family: 0, all: false, order: defaultResultOrder };
  }
  if (typeof options !== "object") {
    throw invalidArgType("options", ["integer", "object"], options);
  }
  const opts = options as LookupOptions;
  if (opts.hints !== undefined && opts.hints !== null) {
    if (typeof opts.hints !== "number") {
      throw invalidArgType("options.hints", "number", opts.hints);
    }
    // Read as Node reads them: an unsigned integer of getaddrinfo's flags only.
    const hints = opts.hints >>> 0;
    if ((hints & ~(ADDRCONFIG | ALL | V4MAPPED)) !== 0) {
      throw invalidArgValue("hints", hints);
    }
  }
  if (opts.all !== undefined && typeof opts.all !== "boolean") {
    throw invalidArgType("options.all", "boolean", opts.all);
  }
  let order: ResultOrder = defaultResultOrder;
  if (opts.verbatim !== undefined) {
    if (typeof opts.verbatim !== "boolean") {
      throw invalidArgType("options.verbatim", "boolean", opts.verbatim);
    }
    order = opts.verbatim ? "verbatim" : "ipv4first";
  }
  if (opts.order !== undefined) {
    if (opts.order !== "ipv4first" && opts.order !== "ipv6first" && opts.order !== "verbatim") {
      throw invalidArgValue(
        "options.order",
        opts.order,
        "must be one of: 'verbatim', 'ipv4first', 'ipv6first'",
      );
    }
    order = opts.order;
  }
  return { family: validateFamily(opts.family), all: Boolean(opts.all), order };
}

/**
 * The addresses `hostname` resolves to, in result order, or an `ENOTFOUND`
 * error. An IP literal resolves to itself, in its own family whatever
 * `family` asks for, as Node answers it without getaddrinfo.
 */
export function lookupAddresses(
  hostname: string,
  family: 0 | 4 | 6,
  order: ResultOrder,
): LookupAddress[] | Error {
  const literal = isIP(hostname);
  if (literal !== 0) {
    return [{ address: hostname, family: literal }];
  }
  if (!isLocalHost(hostname)) {
    return notFoundError(hostname);
  }
  const v4: LookupAddress = { address: "127.0.0.1", family: 4 };
  const v6: LookupAddress = { address: "::1", family: 6 };
  if (family === 4) {
    return [v4];
  }
  if (family === 6) {
    return [v6];
  }
  return order === "ipv6first" ? [v6, v4] : [v4, v6];
}

type LookupCallback = (
  error: Error | null,
  address?: string | LookupAddress[] | null,
  family?: number,
) => void;

/** Node 26's error for a lookup of no name (DEP0118 has run its course). */
function emptyHostname(hostname: unknown): Error {
  return invalidArgValue("hostname", hostname, "must be a non-empty string");
}

/** `dns.lookup(hostname[, options], callback)`. */
export function lookup(hostname: string, options: unknown, callback?: LookupCallback): object {
  let cb = callback;
  let opts = options;
  if (typeof opts === "function") {
    cb = opts as LookupCallback;
    opts = undefined;
  }
  if (hostname) {
    validateString(hostname, "hostname");
  }
  validateFunction(cb, "callback");
  const done = cb as LookupCallback;
  const { family, all, order } = normalizeLookupOptions(opts);
  if (!hostname) {
    throw emptyHostname(hostname);
  }
  const result = lookupAddresses(hostname, family, order);
  const answer = () => {
    if (result instanceof Error) {
      done(result);
    } else if (all) {
      done(null, result);
    } else {
      done(null, result[0].address, result[0].family);
    }
  };
  if (isIP(hostname) !== 0) {
    nextTick(answer);
  } else {
    complete(answer);
  }
  return {};
}

const SERVICES: Record<number, string> = {
  21: "ftp",
  22: "ssh",
  23: "telnet",
  25: "smtp",
  53: "domain",
  80: "http",
  443: "https",
  3306: "mysql",
  5432: "postgresql",
  6379: "redis",
  8080: "http-alt",
};

/** The `lookupService` answer for a loopback address, or an error. */
export function lookupServiceResult(
  address: string,
  port: number,
): { hostname: string; service: string } | Error {
  if (isIP(address) === 0) {
    throw invalidArgValue("address", address);
  }
  validatePort(port);
  if (address === "127.0.0.1" || address === "::1") {
    return { hostname: "localhost", service: SERVICES[port] ?? String(port) };
  }
  return notFoundError(address, "getnameinfo");
}

/** `dns.lookupService(address, port, callback)`. */
export function lookupService(
  address: string,
  port: number,
  callback: (error: Error | null, hostname?: string, service?: string) => void,
): object {
  if (arguments.length !== 3) {
    throw makeNodeError<TypeError>(
      "ERR_MISSING_ARGS",
      'The "address", "port", and "callback" arguments must be specified',
      TypeError,
    );
  }
  // The address and port first, then the callback, in Node's order.
  const result = lookupServiceResult(address, port);
  validateFunction(callback, "callback");
  complete(() => {
    if (result instanceof Error) {
      callback(result);
    } else {
      callback(null, result.hostname, result.service);
    }
  });
  return {};
}

/** The `query*` syscall Node names for each record type. */
export const QUERY_SYSCALLS: Record<string, string> = {
  A: "queryA",
  AAAA: "queryAaaa",
  ANY: "queryAny",
  CAA: "queryCaa",
  CNAME: "queryCname",
  MX: "queryMx",
  NAPTR: "queryNaptr",
  NS: "queryNs",
  PTR: "queryPtr",
  SOA: "querySoa",
  SRV: "querySrv",
  TXT: "queryTxt",
};

/** The `resolveXxx` method name for each record type. */
export const RESOLVE_METHODS: Record<string, string> = {
  A: "resolve4",
  AAAA: "resolve6",
  ANY: "resolveAny",
  CAA: "resolveCaa",
  CNAME: "resolveCname",
  MX: "resolveMx",
  NAPTR: "resolveNaptr",
  NS: "resolveNs",
  PTR: "resolvePtr",
  SOA: "resolveSoa",
  SRV: "resolveSrv",
  TXT: "resolveTxt",
};

/** Validates `resolve(hostname, rrtype)` arguments; returns the record type. */
export function validateResolve(hostname: unknown, rrtype: unknown): string {
  validateString(hostname, "name");
  const type = rrtype ?? "A";
  validateString(type, "rrtype");
  if (!(type in QUERY_SYSCALLS)) {
    throw invalidArgValue("rrtype", type);
  }
  return type;
}

/** Validates `setServers(servers)`: an array of `ip`, `ip:port` or `[ipv6]:port` strings. */
export function validateServers(servers: unknown): string[] {
  if (!Array.isArray(servers)) {
    throw invalidArgType("servers", "Array", servers);
  }
  return servers.map((server, index) => {
    validateString(server, `servers[${index}]`);
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(server);
    const host = bracket ? bracket[1] : isIP(server) ? server : server.replace(/:\d+$/, "");
    if (isIP(host) === 0) {
      throw makeNodeError<TypeError>(
        "ERR_INVALID_IP_ADDRESS",
        `Invalid IP address: ${server}`,
        TypeError,
      );
    }
    return server;
  });
}

type QueryCallback = (error: Error | null, result?: unknown) => void;

function query(type: string) {
  return function resolveQuery(
    this: unknown,
    hostname: string,
    options: QueryCallback | { ttl?: boolean },
    callback?: QueryCallback,
  ): object {
    const cb = (typeof options === "function" ? options : callback) as QueryCallback;
    validateString(hostname, "hostname");
    validateFunction(cb, "callback");
    const error = queryError(QUERY_SYSCALLS[type], hostname);
    complete(() => cb(error));
    return {};
  };
}

/** `dns.Resolver`: an independent resolver with its own servers. */
export class Resolver {
  #servers: string[] = [];

  constructor(options?: { timeout?: number; tries?: number }) {
    if (options !== undefined && (typeof options !== "object" || options === null)) {
      throw invalidArgType("options", "Object", options);
    }
  }

  cancel(): void {}

  getServers(): string[] {
    return [...this.#servers];
  }

  setServers(servers: string[]): void {
    this.#servers = validateServers(servers);
  }

  setLocalAddress(ipv4?: string, ipv6?: string): void {
    if (ipv4 !== undefined) {
      validateString(ipv4, "ipv4");
    }
    if (ipv6 !== undefined) {
      validateString(ipv6, "ipv6");
    }
  }

  resolve(hostname: string, rrtype?: string | QueryCallback, callback?: QueryCallback): object {
    const cb = (typeof rrtype === "function" ? rrtype : callback) as QueryCallback;
    const type = validateResolve(hostname, typeof rrtype === "function" ? undefined : rrtype);
    validateFunction(cb, "callback");
    const error = queryError(QUERY_SYSCALLS[type], hostname);
    complete(() => cb(error));
    return {};
  }

  reverse(ip: string, callback: QueryCallback): object {
    validateString(ip, "ip");
    validateFunction(callback, "callback");
    const error = queryError("getHostByAddr", ip);
    complete(() => callback(error));
    return {};
  }

  declare resolve4: ReturnType<typeof query>;
  declare resolve6: ReturnType<typeof query>;
  declare resolveAny: ReturnType<typeof query>;
  declare resolveCaa: ReturnType<typeof query>;
  declare resolveCname: ReturnType<typeof query>;
  declare resolveMx: ReturnType<typeof query>;
  declare resolveNaptr: ReturnType<typeof query>;
  declare resolveNs: ReturnType<typeof query>;
  declare resolvePtr: ReturnType<typeof query>;
  declare resolveSoa: ReturnType<typeof query>;
  declare resolveSrv: ReturnType<typeof query>;
  declare resolveTxt: ReturnType<typeof query>;
}

for (const [type, method] of Object.entries(RESOLVE_METHODS)) {
  Object.defineProperty(Resolver.prototype, method, {
    configurable: true,
    writable: true,
    value: query(type),
  });
}

const defaultResolver = new Resolver();

/** `dns.getServers()`. */
export function getServers(): string[] {
  return defaultResolver.getServers();
}

/** `dns.setServers(servers)`. */
export function setServers(servers: string[]): void {
  defaultResolver.setServers(servers);
}

/** `dns.resolve(hostname[, rrtype], callback)`. */
export function resolve(
  hostname: string,
  rrtype?: string | QueryCallback,
  callback?: QueryCallback,
): object {
  return defaultResolver.resolve(hostname, rrtype, callback);
}

/** `dns.reverse(ip, callback)`. */
export function reverse(ip: string, callback: QueryCallback): object {
  return defaultResolver.reverse(ip, callback);
}

/** A promise of `outcome`, settled from the event loop, as a getaddrinfo or c-ares answer is. */
function answerLater<T>(outcome: T | Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    complete(() => (outcome instanceof Error ? reject(outcome) : resolve(outcome)));
  });
}

/** `dnsPromises.lookup(hostname[, options])`. */
function lookupPromise(
  hostname: string,
  options?: unknown,
): Promise<LookupAddress | LookupAddress[]> {
  if (hostname) {
    validateString(hostname, "hostname");
  }
  const { family, all, order } = normalizeLookupOptions(options);
  if (!hostname) {
    return Promise.reject(emptyHostname(hostname));
  }
  const result = lookupAddresses(hostname, family, order);
  if (result instanceof Error) {
    return answerLater<LookupAddress>(result);
  }
  const answer = all ? result : result[0];
  // An IP literal needs no getaddrinfo: it settles at once.
  return isIP(hostname) !== 0 ? Promise.resolve(answer) : answerLater(answer);
}

/** `dnsPromises.lookupService(address, port)`. */
function lookupServicePromise(
  address: string,
  port: number,
): Promise<{ hostname: string; service: string }> {
  return answerLater(lookupServiceResult(address, port));
}

function promiseQuery(type: string) {
  return function resolveQuery(hostname: string): Promise<never> {
    validateString(hostname, "hostname");
    return answerLater<never>(queryError(QUERY_SYSCALLS[type], hostname));
  };
}

/** `dnsPromises.Resolver`. */
export class PromiseResolver {
  #servers: string[] = [];

  constructor(options?: { timeout?: number; tries?: number }) {
    if (options !== undefined && (typeof options !== "object" || options === null)) {
      throw invalidArgType("options", "Object", options);
    }
  }

  cancel(): void {}

  getServers(): string[] {
    return [...this.#servers];
  }

  setServers(servers: string[]): void {
    this.#servers = validateServers(servers);
  }

  setLocalAddress(ipv4?: string, ipv6?: string): void {
    if (ipv4 !== undefined) {
      validateString(ipv4, "ipv4");
    }
    if (ipv6 !== undefined) {
      validateString(ipv6, "ipv6");
    }
  }

  resolve(hostname: string, rrtype?: string): Promise<never> {
    const type = validateResolve(hostname, rrtype);
    return answerLater<never>(queryError(QUERY_SYSCALLS[type], hostname));
  }

  reverse(ip: string): Promise<never> {
    validateString(ip, "ip");
    return answerLater<never>(queryError("getHostByAddr", ip));
  }

  declare resolve4: ReturnType<typeof promiseQuery>;
  declare resolve6: ReturnType<typeof promiseQuery>;
  declare resolveAny: ReturnType<typeof promiseQuery>;
  declare resolveCaa: ReturnType<typeof promiseQuery>;
  declare resolveCname: ReturnType<typeof promiseQuery>;
  declare resolveMx: ReturnType<typeof promiseQuery>;
  declare resolveNaptr: ReturnType<typeof promiseQuery>;
  declare resolveNs: ReturnType<typeof promiseQuery>;
  declare resolvePtr: ReturnType<typeof promiseQuery>;
  declare resolveSoa: ReturnType<typeof promiseQuery>;
  declare resolveSrv: ReturnType<typeof promiseQuery>;
  declare resolveTxt: ReturnType<typeof promiseQuery>;
}

for (const [type, method] of Object.entries(RESOLVE_METHODS)) {
  Object.defineProperty(PromiseResolver.prototype, method, {
    configurable: true,
    writable: true,
    value: promiseQuery(type),
  });
}

const defaultPromiseResolver = new PromiseResolver();

/** What `require("dns/promises")` (and `dns.promises`) returns. */
export const promises = {
  lookup: lookupPromise,
  lookupService: lookupServicePromise,
  Resolver: PromiseResolver,
  getDefaultResultOrder,
  setDefaultResultOrder,
  setServers: (servers: string[]) => defaultPromiseResolver.setServers(servers),
  ...ERROR_CODES,
  getServers: () => defaultPromiseResolver.getServers(),
  resolve: (hostname: string, rrtype?: string) => defaultPromiseResolver.resolve(hostname, rrtype),
  resolve4: defaultPromiseResolver.resolve4.bind(defaultPromiseResolver),
  resolve6: defaultPromiseResolver.resolve6.bind(defaultPromiseResolver),
  resolveAny: defaultPromiseResolver.resolveAny.bind(defaultPromiseResolver),
  resolveCaa: defaultPromiseResolver.resolveCaa.bind(defaultPromiseResolver),
  resolveCname: defaultPromiseResolver.resolveCname.bind(defaultPromiseResolver),
  resolveMx: defaultPromiseResolver.resolveMx.bind(defaultPromiseResolver),
  resolveNaptr: defaultPromiseResolver.resolveNaptr.bind(defaultPromiseResolver),
  resolveNs: defaultPromiseResolver.resolveNs.bind(defaultPromiseResolver),
  resolvePtr: defaultPromiseResolver.resolvePtr.bind(defaultPromiseResolver),
  resolveSoa: defaultPromiseResolver.resolveSoa.bind(defaultPromiseResolver),
  resolveSrv: defaultPromiseResolver.resolveSrv.bind(defaultPromiseResolver),
  resolveTxt: defaultPromiseResolver.resolveTxt.bind(defaultPromiseResolver),
  reverse: (ip: string) => defaultPromiseResolver.reverse(ip),
};

/** What `require("dns")` returns. */
const dns = {
  lookup,
  lookupService,
  Resolver,
  getDefaultResultOrder,
  setDefaultResultOrder,
  setServers,
  ADDRCONFIG,
  ALL,
  V4MAPPED,
  ...ERROR_CODES,
  getServers,
  resolve,
  resolve4: defaultResolver.resolve4.bind(defaultResolver),
  resolve6: defaultResolver.resolve6.bind(defaultResolver),
  resolveAny: defaultResolver.resolveAny.bind(defaultResolver),
  resolveCaa: defaultResolver.resolveCaa.bind(defaultResolver),
  resolveCname: defaultResolver.resolveCname.bind(defaultResolver),
  resolveMx: defaultResolver.resolveMx.bind(defaultResolver),
  resolveNaptr: defaultResolver.resolveNaptr.bind(defaultResolver),
  resolveNs: defaultResolver.resolveNs.bind(defaultResolver),
  resolvePtr: defaultResolver.resolvePtr.bind(defaultResolver),
  resolveSoa: defaultResolver.resolveSoa.bind(defaultResolver),
  resolveSrv: defaultResolver.resolveSrv.bind(defaultResolver),
  resolveTxt: defaultResolver.resolveTxt.bind(defaultResolver),
  reverse,
  promises,
};

export default dns;
