// IP address rules for the `net` domain: `isIP`/`isIPv4`/`isIPv6` with Node's
// exact regular expressions, address parsing into one 128-bit space (IPv4 as
// `::ffff:a.b.c.d`), `SocketAddress`, `BlockList`, and the one rule for which
// hosts are this machine (the loopback a process can reach in webnode).
import { HOSTNAME } from "../../platform";
import { invalidArgType, invalidArgValue, makeNodeError, validateObject } from "../internalErrors";

const v4Seg = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);
const v6Seg = "(?:[0-9a-fA-F]{1,4})";
const IPv6Reg = new RegExp(
  "^(?:" +
    `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
    `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
    `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
    `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
    `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
    `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
    `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
    `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
    ")(?:%[0-9a-zA-Z-.:]{1,})?$",
);

/** `net.isIPv4(input)`. */
export function isIPv4(input: unknown): boolean {
  return IPv4Reg.test(`${String(input)}`);
}

/** `net.isIPv6(input)`. */
export function isIPv6(input: unknown): boolean {
  return IPv6Reg.test(`${String(input)}`);
}

/** `net.isIP(input)`: 4, 6, or 0. */
export function isIP(input: unknown): 0 | 4 | 6 {
  if (isIPv4(input)) {
    return 4;
  }
  if (isIPv6(input)) {
    return 6;
  }
  return 0;
}

const MAPPED_PREFIX = 0xffffn << 32n;

function v4ToBigInt(address: string): bigint {
  let value = 0n;
  for (const part of address.split(".")) {
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

/** The address as a 128-bit number; IPv4 lands in `::ffff:0:0/96`. Null when it is not an IP. */
export function addressToBigInt(address: string): bigint | null {
  if (isIPv4(address)) {
    return MAPPED_PREFIX | v4ToBigInt(address);
  }
  if (!isIPv6(address)) {
    return null;
  }
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) {
    text = text.slice(0, zone);
  }
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    // An embedded IPv4 tail ("::ffff:1.2.3.4") is the last two groups.
    const v4 = v4ToBigInt(lastPart);
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) {
      text = text.slice(0, -1);
    }
  }
  const [head, rest] = text.includes("::") ? text.split("::") : [text, null];
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const headGroups = parse(head);
  let groups: number[];
  if (rest === null) {
    groups = [...headGroups, ...tail];
  } else {
    const restGroups = [...parse(rest), ...tail];
    const fill = 8 - headGroups.length - restGroups.length;
    groups = [...headGroups, ...Array<number>(Math.max(fill, 0)).fill(0), ...restGroups];
  }
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

/** Whether `host` names this machine: the loopback interface a process can reach. */
export function isLocalHost(host: string): boolean {
  let name = host.toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) {
    name = name.slice(1, -1);
  }
  if (name.endsWith(".")) {
    name = name.slice(0, -1);
  }
  // Every *.localhost name is loopback (RFC 6761), as dns.lookup answers.
  if (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === HOSTNAME.toLowerCase() ||
    name === "0.0.0.0"
  ) {
    return true;
  }
  if (name === "::" || name === "::1") {
    return true;
  }
  const value = addressToBigInt(name);
  if (value === null) {
    return false;
  }
  // 127.0.0.0/8, also as ::ffff:127.x.x.x.
  return value >> 24n === (MAPPED_PREFIX | (127n << 24n)) >> 24n || value === 1n || value === 0n;
}

/** The loopback address to reach for a local `host`: `::1` for IPv6 forms, else `127.0.0.1`. */
export function loopbackFor(host: string): { address: string; family: 4 | 6 } {
  const name = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIPv6(name) && !name.toLowerCase().startsWith("::ffff:")) {
    return { address: "::1", family: 6 };
  }
  if (isIPv4(name) && name !== "0.0.0.0") {
    return { address: name, family: 4 };
  }
  return { address: "127.0.0.1", family: 4 };
}

function validateFamily(family: unknown, name: string): "ipv4" | "ipv6" {
  if (typeof family !== "string") {
    throw invalidArgType(name, "string", family);
  }
  const lower = family.toLowerCase();
  if (lower !== "ipv4" && lower !== "ipv6") {
    throw invalidArgValue(name, family);
  }
  return lower;
}

function invalidAddress(): Error {
  return makeNodeError("ERR_INVALID_ADDRESS", "Invalid socket address", Error);
}

function badPort(name: string, port: unknown): RangeError {
  return makeNodeError<RangeError>(
    "ERR_SOCKET_BAD_PORT",
    `${name} should be >= 0 and < 65536. Received ${describePort(port)}.`,
    RangeError,
  );
}

function describePort(port: unknown): string {
  if (typeof port === "string") {
    return `type string ('${port}')`;
  }
  if (typeof port === "number") {
    return `type number (${port})`;
  }
  return port === null ? "null" : `type ${typeof port}`;
}

/** Node's `validatePort`: a number or numeric string in 0..65535 (`ERR_SOCKET_BAD_PORT`). */
export function validatePort(port: unknown, name = "Port", allowZero = true): number {
  if (
    (typeof port !== "number" && typeof port !== "string") ||
    (typeof port === "string" && port.trim().length === 0) ||
    +port !== +port >>> 0 ||
    +port > 0xffff ||
    (+port === 0 && !allowZero)
  ) {
    if (!allowZero) {
      throw makeNodeError<RangeError>(
        "ERR_SOCKET_BAD_PORT",
        `${name} should be > 0 and < 65536. Received ${describePort(port)}.`,
        RangeError,
      );
    }
    throw badPort(name, port);
  }
  return +port | 0;
}

const kSocketAddress = Symbol("kSocketAddress");

/** The options `new net.SocketAddress(options)` takes. */
export interface SocketAddressOptions {
  address?: string;
  port?: number;
  family?: string;
  flowlabel?: number;
}

/** `net.SocketAddress`: an immutable address, port and family. */
export class SocketAddress {
  readonly [kSocketAddress] = true;
  readonly #address: string;
  readonly #port: number;
  readonly #family: "ipv4" | "ipv6";
  readonly #flowlabel: number;

  constructor(options: SocketAddressOptions = {}) {
    validateObject(options, "options");
    const family = validateFamily(options.family ?? "ipv4", "options.family");
    const address = options.address ?? (family === "ipv4" ? "127.0.0.1" : "::");
    if (typeof address !== "string") {
      throw invalidArgType("options.address", "string", address);
    }
    const port = validatePort(options.port ?? 0, "Port");
    const flowlabel = options.flowlabel ?? 0;
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xffffffff) {
      throw invalidArgValue("options.flowlabel", flowlabel);
    }
    if ((family === "ipv4" && !isIPv4(address)) || (family === "ipv6" && !isIPv6(address))) {
      throw invalidAddress();
    }
    this.#address = address;
    this.#port = port;
    this.#family = family;
    this.#flowlabel = flowlabel;
  }

  get address(): string {
    return this.#address;
  }

  get port(): number {
    return this.#port;
  }

  get family(): "ipv4" | "ipv6" {
    return this.#family;
  }

  get flowlabel(): number {
    return this.#flowlabel;
  }

  toJSON(): { address: string; port: number; family: string; flowlabel: number } {
    return {
      address: this.#address,
      port: this.#port,
      family: this.#family,
      flowlabel: this.#flowlabel,
    };
  }

  /** Whether `value` is a `SocketAddress`. */
  static isSocketAddress(value: unknown): value is SocketAddress {
    return typeof value === "object" && value !== null && kSocketAddress in value;
  }

  /** Parses `"1.2.3.4:80"` or `"[::1]:80"`; undefined when it is not an address. */
  static parse(input: string): SocketAddress | undefined {
    if (typeof input !== "string") {
      throw invalidArgType("input", "string", input);
    }
    try {
      const url = new URL(`http://${input}`);
      const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      const family = isIPv6(hostname) ? "ipv6" : "ipv4";
      return new SocketAddress({
        address: hostname,
        port: url.port === "" ? 0 : Number(url.port),
        family,
      });
    } catch {
      return undefined;
    }
  }
}

type Rule =
  | { kind: "address"; family: "ipv4" | "ipv6"; text: string; value: bigint }
  | { kind: "range"; family: "ipv4" | "ipv6"; text: string; start: bigint; end: bigint }
  | { kind: "subnet"; family: "ipv4" | "ipv6"; text: string; base: bigint; bits: number };

const kBlockList = Symbol("kBlockList");

function familyLabel(family: "ipv4" | "ipv6"): string {
  return family === "ipv4" ? "IPv4" : "IPv6";
}

function addressArgument(
  address: unknown,
  family: unknown,
  name: string,
): { text: string; family: "ipv4" | "ipv6"; value: bigint } {
  if (SocketAddress.isSocketAddress(address)) {
    const value = addressToBigInt(address.address) as bigint;
    return { text: address.address, family: address.family, value };
  }
  if (typeof address !== "string") {
    throw invalidArgType(name, ["string", "SocketAddress"], address);
  }
  const fam = validateFamily(family, "family");
  if ((fam === "ipv4" && !isIPv4(address)) || (fam === "ipv6" && !isIPv6(address))) {
    throw invalidAddress();
  }
  return { text: address, family: fam, value: addressToBigInt(address) as bigint };
}

/** `net.BlockList`: rules that match addresses, ranges and subnets. IPv4 rules also match `::ffff:` forms. */
export class BlockList {
  readonly [kBlockList] = true;
  #rules: Rule[] = [];

  /** Whether `value` is a `BlockList`. */
  static isBlockList(value: unknown): value is BlockList {
    return typeof value === "object" && value !== null && kBlockList in value;
  }

  addAddress(address: string | SocketAddress, family = "ipv4"): void {
    const parsed = addressArgument(address, family, "address");
    this.#rules.unshift({
      kind: "address",
      family: parsed.family,
      text: parsed.text,
      value: parsed.value,
    });
  }

  addRange(start: string | SocketAddress, end: string | SocketAddress, family = "ipv4"): void {
    const from = addressArgument(start, family, "start");
    const to = addressArgument(end, family, "end");
    if (from.value > to.value) {
      throw invalidArgValue("start", start, "must come before end");
    }
    this.#rules.unshift({
      kind: "range",
      family: from.family,
      text: `${from.text}-${to.text}`,
      start: from.value,
      end: to.value,
    });
  }

  addSubnet(network: string | SocketAddress, prefix: number, family = "ipv4"): void {
    const base = addressArgument(network, family, "network");
    const max = base.family === "ipv4" ? 32 : 128;
    if (typeof prefix !== "number") {
      throw invalidArgType("prefix", "number", prefix);
    }
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw makeNodeError<RangeError>(
        "ERR_OUT_OF_RANGE",
        `The value of "prefix" is out of range. It must be >= 0 && <= ${max}. Received ${prefix}`,
        RangeError,
      );
    }
    const bits = base.family === "ipv4" ? prefix + 96 : prefix;
    this.#rules.unshift({
      kind: "subnet",
      family: base.family,
      text: `${base.text}/${prefix}`,
      base: base.value,
      bits,
    });
  }

  check(address: string | SocketAddress, family = "ipv4"): boolean {
    let value: bigint;
    try {
      value = addressArgument(address, family, "address").value;
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_INVALID_ADDRESS") {
        return false;
      }
      throw error;
    }
    for (const rule of this.#rules) {
      if (rule.kind === "address" && rule.value === value) {
        return true;
      }
      if (rule.kind === "range" && value >= rule.start && value <= rule.end) {
        return true;
      }
      if (rule.kind === "subnet") {
        const shift = BigInt(128 - rule.bits);
        if (value >> shift === rule.base >> shift) {
          return true;
        }
      }
    }
    return false;
  }

  get rules(): string[] {
    return this.#rules.map((rule) => {
      const label =
        rule.kind === "address" ? "Address" : rule.kind === "range" ? "Range" : "Subnet";
      return `${label}: ${familyLabel(rule.family)} ${rule.text}`;
    });
  }
}
