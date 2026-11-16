// The builtin-module registry: the one table that maps a name such as `fs` or
// `node:stream/promises` to the module `require` returns. Each builtin lives in
// its own file; this hub only lists them.
import assert from "./assert";
import assertStrict from "./assert_strict";
import asyncHooks from "./async_hooks";
import buffer from "./buffer";
import childProcess from "./child_process";
import cluster from "./cluster";
import constants from "./constants";
import crypto from "./crypto";
import dgram from "./dgram";
import diagnosticsChannel from "./diagnostics_channel";
import dns from "./dns";
import dnsPromises from "./dns_promises";
import domain from "./domain";
import events from "./events";
import fs from "./fs";
import fsPromises from "./fs_promises";
import http from "./http";
import http2 from "./http2";
import https from "./https";
import inspector from "./inspector";
import moduleBuiltin from "./module";
import net from "./net";
import os from "./os";
import path from "./path";
import perfHooks from "./perf_hooks";
import punycode from "./punycode";
import querystring from "./querystring";
import readline from "./readline";
import readlinePromises from "./readline_promises";
import repl from "./repl";
import stream from "./stream";
import streamConsumers from "./stream_consumers";
import streamPromises from "./stream_promises";
import streamWeb from "./stream_web";
import stringDecoder from "./string_decoder";
import timers from "./timers";
import timersPromises from "./timers_promises";
import tls from "./tls";
import traceEvents from "./trace_events";
import tty from "./tty";
import url from "./url";
import util from "./util";
import utilTypes from "./util_types";
import v8 from "./v8";
import vm from "./vm";
import wasi from "./wasi";
import workerThreads from "./worker_threads";
import zlib from "./zlib";

/** What a process supplies itself: its own `process` object and console. */
export interface ProcessBuiltins {
  process: unknown;
  console: unknown;
}

let own: ProcessBuiltins | null = null;

/** Registers the process's own `process` and `console` as the builtins of those names. */
export function setProcessBuiltins(builtins: ProcessBuiltins): void {
  own = builtins;
}

function unavailable(name: string): never {
  throw Object.assign(new Error(`The builtin module "${name}" is not available in webnode`), {
    code: "ERR_UNKNOWN_BUILTIN_MODULE",
  });
}

const streamParts = stream as unknown as Record<string, unknown>;

const builtins: Record<string, () => unknown> = {
  assert: () => assert,
  "assert/strict": () => assertStrict,
  async_hooks: () => asyncHooks,
  buffer: () => buffer,
  child_process: () => childProcess,
  cluster: () => cluster,
  console: () => own?.console ?? globalThis.console,
  constants: () => constants,
  crypto: () => crypto,
  dgram: () => dgram,
  diagnostics_channel: () => diagnosticsChannel,
  dns: () => dns,
  "dns/promises": () => dnsPromises,
  domain: () => domain,
  events: () => events,
  fs: () => fs,
  "fs/promises": () => fsPromises,
  http: () => http,
  http2: () => http2,
  https: () => https,
  inspector: () => inspector,
  "inspector/promises": () => inspector,
  module: () => moduleBuiltin,
  net: () => net,
  os: () => os,
  path: () => path,
  "path/posix": () => path.posix,
  "path/win32": () => path.win32,
  perf_hooks: () => perfHooks,
  process: () => own?.process,
  punycode: () => punycode,
  querystring: () => querystring,
  readline: () => readline,
  "readline/promises": () => readlinePromises,
  repl: () => repl,
  stream: () => stream,
  "stream/consumers": () => streamConsumers,
  "stream/promises": () => streamPromises,
  "stream/web": () => streamWeb,
  string_decoder: () => stringDecoder,
  sys: () => util,
  timers: () => timers,
  "timers/promises": () => timersPromises,
  tls: () => tls,
  trace_events: () => traceEvents,
  tty: () => tty,
  url: () => url,
  util: () => util,
  "util/types": () => utilTypes,
  v8: () => v8,
  vm: () => vm,
  wasi: () => wasi,
  worker_threads: () => workerThreads,
  zlib: () => zlib,
  _stream_duplex: () => streamParts.Duplex,
  _stream_passthrough: () => streamParts.PassThrough,
  _stream_readable: () => streamParts.Readable,
  _stream_transform: () => streamParts.Transform,
  _stream_writable: () => streamParts.Writable,
};

/** The exports of builtin module `name` (without the `node:` prefix). */
export function loadBuiltin(name: string): unknown {
  const load = builtins[name];
  if (!load) {
    return unavailable(name);
  }
  return load();
}
