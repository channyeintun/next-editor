// The names of Node's builtin modules: the ones `require("fs")` reaches bare,
// and the ones that need the `node:` prefix.

/** Builtins reachable with or without the `node:` prefix, as `module.builtinModules` lists them. */
export const BUILTIN_MODULE_NAMES: readonly string[] = [
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

/** Builtins that exist only as `node:<name>`. */
export const PREFIX_ONLY_BUILTIN_NAMES: readonly string[] = [
  "sea",
  "sqlite",
  "test",
  "test/reporters",
];

const bare = new Set(BUILTIN_MODULE_NAMES);
const prefixOnly = new Set(PREFIX_ONLY_BUILTIN_NAMES);

/** The builtin's name without `node:` when `specifier` names one, else null. */
export function builtinName(specifier: string): string | null {
  if (specifier.startsWith("node:")) {
    const name = specifier.slice(5);
    return bare.has(name) || prefixOnly.has(name) ? name : null;
  }
  return bare.has(specifier) ? specifier : null;
}
