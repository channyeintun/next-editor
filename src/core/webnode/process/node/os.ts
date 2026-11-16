// The `os` builtin: the simulated Linux machine a webnode process runs on.
// Names and paths come from process/platform.ts; the hardware figures come from
// what the browser exposes (`navigator.hardwareConcurrency`,
// `navigator.deviceMemory`, `performance.memory`). Also owns the Linux
// `os.constants` tables (signals, priority, dlopen) that `constants` merges.
import { errnoTable } from "../../errors";
import { runtime } from "../runtime";
import { ARCH, HOME_DIR, HOSTNAME, PLATFORM, SHELL_PATH, TMP_DIR, USERNAME } from "../platform";
import { Buffer } from "./buffer";
import { invalidArgType, validateInteger, validateObject } from "./internalErrors";

/** When this module was evaluated, in `performance.now()` milliseconds: the machine's boot. */
const bootedAt = performance.now();

/**
 * The kernel release the simulated machine reports. There is no real kernel;
 * this is one fixed string so `os.release()` and `os.version()` agree with each
 * other everywhere webnode runs.
 */
const KERNEL_RELEASE = "6.8.0-webnode";
const KERNEL_VERSION = "#1 SMP PREEMPT_DYNAMIC webnode";

/** The user every process runs as. */
const UID = 1000;
const GID = 1000;

/** Assumed RAM when the browser reports none: 4 GiB. */
const DEFAULT_TOTAL_MEMORY = 4 * 1024 ** 3;

/** Linux signal numbers, in the order Node lists them on Linux. */
export const signals: Readonly<Record<string, number>> = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGIOT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGSTKFLT: 16,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPOLL: 29,
  SIGPWR: 30,
  SIGSYS: 31,
});

/** `os.constants.priority`. */
export const priority: Record<string, number> = {
  PRIORITY_LOW: 19,
  PRIORITY_BELOW_NORMAL: 10,
  PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7,
  PRIORITY_HIGH: -14,
  PRIORITY_HIGHEST: -20,
};

/** `os.constants.dlopen`, Linux values. */
export const dlopen: Record<string, number> = {
  RTLD_LAZY: 1,
  RTLD_NOW: 2,
  RTLD_GLOBAL: 256,
  RTLD_LOCAL: 0,
  RTLD_DEEPBIND: 8,
};

/** `os.constants.errno`. */
export const errno: Record<string, number> = errnoTable();

/** `os.constants`: only `signals` is frozen, as in Node. */
export const constants = {
  UV_UDP_REUSEADDR: 4,
  dlopen,
  errno,
  signals,
  priority,
};

interface BrowserNavigator {
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function browserNavigator(): BrowserNavigator | undefined {
  return (globalThis as { navigator?: BrowserNavigator }).navigator;
}

function performanceMemory(): PerformanceMemory | undefined {
  return (performance as unknown as { memory?: PerformanceMemory }).memory;
}

/** The process environment, or an empty one when no runtime is installed. */
function env(): Record<string, string> {
  try {
    return runtime().env;
  } catch {
    return {};
  }
}

/** `os.platform()`: `linux`. */
export function platform(): string {
  return PLATFORM;
}

/** `os.arch()`: `x64`. */
export function arch(): string {
  return ARCH;
}

/** `os.type()`: `Linux`. */
export function type(): string {
  return "Linux";
}

/** `os.machine()`: `x86_64`. */
export function machine(): string {
  return "x86_64";
}

/** `os.release()`: the simulated kernel's fixed release string. */
export function release(): string {
  return KERNEL_RELEASE;
}

/** `os.version()`: the simulated kernel's fixed version string. */
export function version(): string {
  return KERNEL_VERSION;
}

/** `os.hostname()`. */
export function hostname(): string {
  return HOSTNAME;
}

/** `os.homedir()`: `$HOME`, else the platform's home directory. */
export function homedir(): string {
  const home = env().HOME;
  return home ? home : HOME_DIR;
}

/** `os.tmpdir()`: `$TMPDIR` (then `$TMP`, `$TEMP`), else `/tmp`, without a trailing slash. */
export function tmpdir(): string {
  const vars = env();
  let path = vars.TMPDIR || vars.TMP || vars.TEMP || TMP_DIR;
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

/** `os.endianness()`: `LE`. */
export function endianness(): "LE" {
  return "LE";
}

/** `os.EOL`. */
export const EOL = "\n";

/** `os.devNull`. */
export const devNull = "/dev/null";

/** `os.availableParallelism()`: the browser's `hardwareConcurrency`. */
export function availableParallelism(): number {
  const count = browserNavigator()?.hardwareConcurrency;
  return typeof count === "number" && count > 0 ? count : 1;
}

/** One `os.cpus()` entry. */
export interface CpuInfo {
  model: string;
  speed: number;
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

/**
 * `os.cpus()`: one entry per logical CPU the browser reports. A browser exposes
 * neither the clock speed nor per-CPU times, so `speed` and every time are 0.
 */
export function cpus(): CpuInfo[] {
  return Array.from({ length: availableParallelism() }, () => ({
    model: "webnode virtual CPU",
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
}

/**
 * `os.totalmem()`: `navigator.deviceMemory` GiB when the browser reports it,
 * else an assumed 4 GiB.
 */
export function totalmem(): number {
  const gib = browserNavigator()?.deviceMemory;
  return typeof gib === "number" && gib > 0 ? gib * 1024 ** 3 : DEFAULT_TOTAL_MEMORY;
}

/**
 * `os.freemem()`: `totalmem()` less the JavaScript heap in use when the browser
 * reports it (`performance.memory`). Without it nothing is known to be used and
 * the whole of `totalmem()` is reported free.
 */
export function freemem(): number {
  const memory = performanceMemory();
  const total = totalmem();
  return memory ? Math.max(0, total - memory.usedJSHeapSize) : total;
}

/** `os.uptime()`: seconds since this worker started. */
export function uptime(): number {
  return (performance.now() - bootedAt) / 1000;
}

/** `os.loadavg()`: a browser reports no load, so `[0, 0, 0]`. */
export function loadavg(): [number, number, number] {
  return [0, 0, 0];
}

/** One `os.networkInterfaces()` address. */
export interface NetworkInterfaceInfo {
  address: string;
  netmask: string;
  family: "IPv4" | "IPv6";
  mac: string;
  internal: boolean;
  cidr: string;
  scopeid?: number;
}

/** `os.networkInterfaces()`: only the loopback interface exists. */
export function networkInterfaces(): Record<string, NetworkInterfaceInfo[]> {
  return {
    lo: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
      {
        address: "::1",
        netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "::1/128",
        scopeid: 0,
      },
    ],
  };
}

/** `os.userInfo()`'s result. */
export interface UserInfo<T> {
  uid: number;
  gid: number;
  username: T;
  homedir: T;
  shell: T;
}

/** `os.userInfo([options])`: strings, or Buffers with `{ encoding: "buffer" }`. */
export function userInfo(options?: { encoding?: string } | string): UserInfo<string | Buffer> {
  let encoding: string | undefined;
  if (typeof options === "string") {
    encoding = options;
  } else if (options !== undefined && options !== null) {
    validateObject(options, "options");
    encoding = options.encoding;
  }
  const info = { uid: UID, gid: GID, username: USERNAME, homedir: homedir(), shell: SHELL_PATH };
  if (encoding === "buffer") {
    return {
      ...info,
      username: Buffer.from(info.username),
      homedir: Buffer.from(info.homedir),
      shell: Buffer.from(info.shell),
    };
  }
  return info;
}

/** Priorities set with `setPriority`, by pid. Scheduling is the browser's; this only remembers them. */
const priorities = new Map<number, number>();

function ownPid(): number {
  try {
    return runtime().pid;
  } catch {
    return 0;
  }
}

/** `os.getPriority([pid])`: what `setPriority` last set, else 0 (normal). */
export function getPriority(pid = 0): number {
  validateInteger(pid, "pid");
  return priorities.get(pid === 0 ? ownPid() : pid) ?? 0;
}

/**
 * `os.setPriority([pid, ]priority)`: validated and remembered for
 * `getPriority`. The browser schedules workers itself, so it has no effect.
 */
export function setPriority(pid: number, value?: number): void {
  if (value === undefined) {
    value = pid;
    pid = 0;
  }
  validateInteger(pid, "pid");
  if (typeof value !== "number") {
    throw invalidArgType("priority", "number", value);
  }
  validateInteger(value, "priority", -20, 19);
  priorities.set(pid === 0 ? ownPid() : pid, value);
}

const os = {
  arch,
  availableParallelism,
  constants,
  cpus,
  devNull,
  endianness,
  EOL,
  freemem,
  getPriority,
  homedir,
  hostname,
  loadavg,
  machine,
  networkInterfaces,
  platform,
  release,
  setPriority,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
  version,
};

export default os;
