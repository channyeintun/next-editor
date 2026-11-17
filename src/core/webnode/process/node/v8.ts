// The `v8` builtin. Heap figures come from `performance.memory` where the
// browser has it. `serialize`/`deserialize` are a real round trip of
// structured-cloneable values in webnode's own tagged binary format: it does
// NOT match V8's wire format, so bytes written by real Node (or written here
// and read by real Node) are not interchangeable. The engine's internals
// (snapshots, coverage, flags, promise hooks) are not reachable from page
// JavaScript; each such member either throws a named error or, where Node
// documents it as advisory, is accepted with no effect.
import { VERSIONS } from "../platform";
import { Buffer } from "./buffer";
import { invalidArgType, makeNodeError, validateString } from "./internalErrors";

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `v8.${name} is not available in webnode`,
  );
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function performanceMemory(): PerformanceMemory | undefined {
  return (globalThis.performance as unknown as { memory?: PerformanceMemory } | undefined)?.memory;
}

/**
 * `v8.getHeapStatistics()`. The heap sizes come from `performance.memory`
 * (Chromium). Where the browser does not report it (a worker may not), there
 * are no figures to give, and zeros would read as a heap with no room left, so
 * it throws. The fields a browser never exposes (malloc, handles, contexts)
 * are 0, apart from the one native context a worker has.
 */
export function getHeapStatistics(): Record<string, number> {
  const memory = performanceMemory();
  if (!memory) {
    throw unavailable("getHeapStatistics");
  }
  const total = memory.totalJSHeapSize;
  const used = memory.usedJSHeapSize;
  const limit = memory.jsHeapSizeLimit;
  return {
    total_heap_size: total,
    total_heap_size_executable: 0,
    total_physical_size: total,
    total_available_size: Math.max(0, limit - used),
    used_heap_size: used,
    heap_size_limit: limit,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
  };
}

/** `v8.getHeapSpaceStatistics()`: a browser does not break its heap down by space. */
export function getHeapSpaceStatistics(): Record<string, unknown>[] {
  return [];
}

/** `v8.getHeapCodeStatistics()`: not observable in a browser, so 0. */
export function getHeapCodeStatistics(): Record<string, number> {
  return {
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
    cpu_profiler_metadata_size: 0,
  };
}

/**
 * `v8.setFlagsFromString(flags)`: accepted with no effect, a documented
 * exception to "throw what the browser cannot do". Page JavaScript cannot
 * change engine flags, and Node itself calls changing them after start-up
 * undefined behaviour; programs set flags to tune, and keep running without.
 */
export function setFlagsFromString(flags: string): void {
  validateString(flags, "flags");
}

/** `v8.cachedDataVersionTag()`: a 32-bit FNV-1a hash of the engine version string. */
export function cachedDataVersionTag(): number {
  let hash = 0x811c9dc5;
  const text = `v8 ${VERSIONS.v8}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * `v8.isStringOneByteRepresentation(content)`: whether every code unit fits in
 * a byte, which is when V8 stores a string one byte per character.
 */
export function isStringOneByteRepresentation(content: string): boolean {
  validateString(content, "content");
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) > 0xff) {
      return false;
    }
  }
  return true;
}

/** `v8.setHeapSnapshotNearHeapLimit(limit)`: accepted, no effect (no heap snapshots here). */
export function setHeapSnapshotNearHeapLimit(_limit: number): void {}

/** `v8.takeCoverage()`: no effect; coverage is collected only under `NODE_V8_COVERAGE`, which webnode lacks. */
export function takeCoverage(): void {}

/** `v8.stopCoverage()`: no effect, as `takeCoverage`. */
export function stopCoverage(): void {}

/** `v8.getHeapSnapshot()`. */
export function getHeapSnapshot(): never {
  throw unavailable("getHeapSnapshot");
}

/** `v8.writeHeapSnapshot()`. */
export function writeHeapSnapshot(): never {
  throw unavailable("writeHeapSnapshot");
}

/** `v8.queryObjects()`. */
export function queryObjects(): never {
  throw unavailable("queryObjects");
}

const noHook = (_hook?: unknown) => () => {};

/**
 * `v8.promiseHooks`: registering is accepted and returns the stop function,
 * but the hooks never run; the browser does not expose V8's promise hooks. A
 * documented exception, like `async_hooks.createHook`: the users are
 * diagnostics tools, which keep working without the events.
 */
export const promiseHooks = Object.freeze({
  onInit: noHook,
  onSettled: noHook,
  onBefore: noHook,
  onAfter: noHook,
  createHook: noHook,
});

function notBuildingSnapshot(): never {
  throw makeNodeError(
    "ERR_NOT_BUILDING_SNAPSHOT",
    "Operation cannot be invoked when not building startup snapshot",
  );
}

/** `v8.startupSnapshot`: webnode never builds a startup snapshot. */
export const startupSnapshot = Object.freeze({
  isBuildingSnapshot: () => false,
  addSerializeCallback: notBuildingSnapshot,
  addDeserializeCallback: notBuildingSnapshot,
  setDeserializeMainFunction: notBuildingSnapshot,
});

/** `v8.GCProfiler`: the browser reports no garbage collections. */
export class GCProfiler {
  start(): never {
    throw unavailable("GCProfiler");
  }

  stop(): never {
    throw unavailable("GCProfiler");
  }
}

function unsupportedClass(name: string) {
  return class {
    constructor() {
      throw unavailable(name);
    }
  };
}

/** `v8.Serializer`: V8's wire format is not reachable from page JavaScript. */
export const Serializer = unsupportedClass("Serializer");
/** `v8.Deserializer`. */
export const Deserializer = unsupportedClass("Deserializer");
/** `v8.DefaultSerializer`. */
export const DefaultSerializer = unsupportedClass("DefaultSerializer");
/** `v8.DefaultDeserializer`. */
export const DefaultDeserializer = unsupportedClass("DefaultDeserializer");

// ---- serialize / deserialize ----------------------------------------------

/** "WNV1": marks webnode's own format. */
const MAGIC = [0x57, 0x4e, 0x56, 0x31];

const T = {
  undefined: 0,
  null: 1,
  true: 2,
  false: 3,
  number: 4,
  bigint: 5,
  string: 6,
  ref: 7,
  array: 8,
  object: 9,
  date: 10,
  regexp: 11,
  map: 12,
  set: 13,
  arrayBuffer: 14,
  view: 15,
  error: 16,
  boxedNumber: 17,
  boxedString: 18,
  boxedBoolean: 19,
  boxedBigint: 20,
  hole: 21,
  end: 22,
} as const;

/** Typed array kinds, by tag. `Buffer` is its own kind so it comes back a Buffer. */
const VIEW_KINDS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "Buffer",
] as const;

const ERROR_NAMES = [
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cloneError(value: unknown): Error {
  let shown: string;
  try {
    shown = typeof value === "function" ? Function.prototype.toString.call(value) : String(value);
  } catch {
    shown = Object.prototype.toString.call(value);
  }
  if (typeof value === "object" && value !== null) {
    shown = `#<${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}>`;
  }
  return new Error(`${shown} could not be cloned.`);
}

class Writer {
  private bytes = new Uint8Array(64);
  private view = new DataView(this.bytes.buffer);
  length = 0;
  private readonly ids = new Map<object, number>();

  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) {
      return;
    }
    let size = this.bytes.length * 2;
    while (size < this.length + count) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  byte(value: number): void {
    this.reserve(1);
    this.bytes[this.length++] = value;
  }

  varint(value: number): void {
    while (value >= 0x80) {
      this.byte((value % 0x80) | 0x80);
      value = Math.floor(value / 0x80);
    }
    this.byte(value);
  }

  float(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  raw(data: Uint8Array): void {
    this.varint(data.length);
    this.reserve(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  string(value: string): void {
    this.raw(encoder.encode(value));
  }

  result(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  /** Writes a back reference when `value` was seen before; otherwise gives it the next id. */
  private seen(value: object): boolean {
    const id = this.ids.get(value);
    if (id !== undefined) {
      this.byte(T.ref);
      this.varint(id);
      return true;
    }
    this.ids.set(value, this.ids.size);
    return false;
  }

  value(value: unknown): void {
    switch (typeof value) {
      case "undefined":
        this.byte(T.undefined);
        return;
      case "boolean":
        this.byte(value ? T.true : T.false);
        return;
      case "number":
        this.byte(T.number);
        this.float(value);
        return;
      case "bigint":
        this.byte(T.bigint);
        this.string(value.toString(16));
        return;
      case "string":
        this.byte(T.string);
        this.string(value);
        return;
      case "symbol":
      case "function":
        throw cloneError(value);
      default:
        break;
    }
    if (value === null) {
      this.byte(T.null);
      return;
    }
    const object = value as object;
    if (this.seen(object)) {
      return;
    }
    if (Array.isArray(object)) {
      this.byte(T.array);
      this.varint(object.length);
      for (let i = 0; i < object.length; i++) {
        if (Object.hasOwn(object, i)) {
          this.value(object[i]);
        } else {
          this.byte(T.hole);
        }
      }
      this.properties(object, (key) => !isIndex(key, object.length));
      return;
    }
    if (object instanceof Date) {
      this.byte(T.date);
      this.float(object.getTime());
      return;
    }
    if (object instanceof RegExp) {
      this.byte(T.regexp);
      this.string(object.source);
      this.string(object.flags);
      return;
    }
    if (object instanceof Map) {
      this.byte(T.map);
      this.varint(object.size);
      for (const [key, entry] of object) {
        this.value(key);
        this.value(entry);
      }
      return;
    }
    if (object instanceof Set) {
      this.byte(T.set);
      this.varint(object.size);
      for (const entry of object) {
        this.value(entry);
      }
      return;
    }
    if (object instanceof ArrayBuffer) {
      this.byte(T.arrayBuffer);
      this.raw(new Uint8Array(object));
      return;
    }
    if (ArrayBuffer.isView(object)) {
      this.byte(T.view);
      const kind = Buffer.isBuffer(object)
        ? "Buffer"
        : (Object.prototype.toString.call(object).slice(8, -1) as (typeof VIEW_KINDS)[number]);
      const index = VIEW_KINDS.indexOf(kind);
      if (index === -1) {
        throw cloneError(object);
      }
      this.byte(index);
      this.raw(new Uint8Array(object.buffer, object.byteOffset, object.byteLength));
      return;
    }
    if (object instanceof Error) {
      this.byte(T.error);
      const name = ERROR_NAMES.find((candidate) => candidate === object.name) ?? "Error";
      this.byte(ERROR_NAMES.indexOf(name));
      this.string(object.message);
      this.value(object.stack);
      if (Object.hasOwn(object, "cause")) {
        this.byte(1);
        this.value(object.cause);
      } else {
        this.byte(0);
      }
      return;
    }
    if (object instanceof Number) {
      this.byte(T.boxedNumber);
      this.float(object.valueOf());
      return;
    }
    if (object instanceof String) {
      this.byte(T.boxedString);
      this.string(object.valueOf());
      return;
    }
    if (object instanceof Boolean) {
      this.byte(T.boxedBoolean);
      this.byte(object.valueOf() ? 1 : 0);
      return;
    }
    if (object instanceof BigInt) {
      this.byte(T.boxedBigint);
      this.string((object as unknown as { valueOf(): bigint }).valueOf().toString(16));
      return;
    }
    if (object instanceof WeakMap || object instanceof WeakSet || object instanceof Promise) {
      throw cloneError(object);
    }
    this.byte(T.object);
    this.properties(object, () => true);
  }

  /** Own enumerable string keys, then T.end. */
  private properties(object: object, include: (key: string) => boolean): void {
    for (const key of Object.keys(object)) {
      if (!include(key)) {
        continue;
      }
      this.byte(T.string);
      this.string(key);
      this.value((object as Record<string, unknown>)[key]);
    }
    this.byte(T.end);
  }
}

function isIndex(key: string, length: number): boolean {
  const index = Number(key);
  return String(index >>> 0) === key && index < length;
}

function negativeHex(text: string): bigint {
  return text.startsWith("-") ? -BigInt(`0x${text.slice(1)}`) : BigInt(`0x${text}`);
}

class Reader {
  private offset = 0;
  private readonly view: DataView;
  private readonly objects: unknown[] = [];
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private fail(): never {
    throw new Error("Unable to deserialize cloned data.");
  }

  byte(): number {
    if (this.offset >= this.bytes.length) {
      this.fail();
    }
    return this.bytes[this.offset++];
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = this.byte();
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        return result;
      }
      scale *= 0x80;
    }
  }

  float(): number {
    if (this.offset + 8 > this.bytes.length) {
      this.fail();
    }
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  raw(): Uint8Array {
    const length = this.varint();
    if (this.offset + length > this.bytes.length) {
      this.fail();
    }
    const data = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return data;
  }

  string(): string {
    return decoder.decode(this.raw());
  }

  skipMagic(): void {
    for (const expected of MAGIC) {
      if (this.byte() !== expected) {
        throw new Error("Unable to deserialize cloned data due to invalid or unsupported version.");
      }
    }
  }

  private keep<V>(value: V): V {
    this.objects.push(value);
    return value;
  }

  value(): unknown {
    const tag = this.byte();
    switch (tag) {
      case T.undefined:
        return undefined;
      case T.null:
        return null;
      case T.true:
        return true;
      case T.false:
        return false;
      case T.number:
        return this.float();
      case T.bigint:
        return negativeHex(this.string());
      case T.string:
        return this.string();
      case T.ref: {
        const id = this.varint();
        if (id >= this.objects.length) {
          this.fail();
        }
        return this.objects[id];
      }
      case T.array: {
        const length = this.varint();
        const array = this.keep([] as unknown[]);
        array.length = length;
        for (let i = 0; i < length; i++) {
          if (this.bytes[this.offset] === T.hole) {
            this.offset++;
            continue;
          }
          array[i] = this.value();
        }
        this.properties(array as unknown as Record<string, unknown>);
        return array;
      }
      case T.object: {
        const object = this.keep({} as Record<string, unknown>);
        this.properties(object);
        return object;
      }
      case T.date:
        return this.keep(new Date(this.float()));
      case T.regexp: {
        const source = this.string();
        return this.keep(new RegExp(source, this.string()));
      }
      case T.map: {
        const map = this.keep(new Map<unknown, unknown>());
        const size = this.varint();
        for (let i = 0; i < size; i++) {
          const key = this.value();
          map.set(key, this.value());
        }
        return map;
      }
      case T.set: {
        const set = this.keep(new Set<unknown>());
        const size = this.varint();
        for (let i = 0; i < size; i++) {
          set.add(this.value());
        }
        return set;
      }
      case T.arrayBuffer:
        return this.keep(this.raw().buffer);
      case T.view:
        return this.keep(this.view_());
      case T.error: {
        const index = this.objects.length;
        this.objects.push(undefined);
        const name = ERROR_NAMES[this.byte()] ?? "Error";
        const message = this.string();
        const Ctor = globalThis[name] as ErrorConstructor;
        const error = new Ctor(message);
        this.objects[index] = error;
        const stack = this.value();
        if (typeof stack === "string") {
          error.stack = stack;
        } else {
          delete error.stack;
        }
        if (this.byte() === 1) {
          Object.defineProperty(error, "cause", {
            value: this.value(),
            writable: true,
            configurable: true,
            enumerable: false,
          });
        }
        return error;
      }
      case T.boxedNumber:
        return this.keep(Object(this.float()) as object);
      case T.boxedString:
        return this.keep(Object(this.string()) as object);
      case T.boxedBoolean:
        return this.keep(Object(this.byte() === 1) as object);
      case T.boxedBigint:
        return this.keep(Object(negativeHex(this.string())) as object);
      default:
        return this.fail();
    }
  }

  private view_(): ArrayBufferView {
    const kind = VIEW_KINDS[this.byte()];
    const data = this.raw();
    switch (kind) {
      case undefined:
        return this.fail();
      case "Buffer":
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      case "DataView":
        return new DataView(data.buffer);
      default: {
        const Ctor = globalThis[kind] as unknown as new (buffer: ArrayBuffer) => ArrayBufferView;
        return new Ctor(data.buffer as ArrayBuffer);
      }
    }
  }

  private properties(target: Record<string, unknown>): void {
    for (;;) {
      const tag = this.byte();
      if (tag === T.end) {
        return;
      }
      if (tag !== T.string) {
        this.fail();
      }
      const key = this.string();
      const value = this.value();
      if (key === "__proto__") {
        // An own "__proto__" key (JSON.parse makes one) stays a property;
        // assigning it would replace the object's prototype.
        Object.defineProperty(target, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        target[key] = value;
      }
    }
  }
}

/** `v8.serialize(value)`: a Buffer holding `value` in webnode's format (see the file comment). */
export function serialize(value: unknown): Buffer {
  const writer = new Writer();
  for (const byte of MAGIC) {
    writer.byte(byte);
  }
  writer.value(value);
  const bytes = writer.result();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `v8.deserialize(buffer)`: the value `serialize` wrote. */
export function deserialize(buffer: ArrayBufferView): unknown {
  if (!ArrayBuffer.isView(buffer)) {
    throw invalidArgType("buffer", ["Buffer", "TypedArray", "DataView"], buffer);
  }
  const reader = new Reader(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  reader.skipMagic();
  return reader.value();
}

const v8 = {
  cachedDataVersionTag,
  getHeapSnapshot,
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics,
  setFlagsFromString,
  Serializer,
  Deserializer,
  DefaultSerializer,
  DefaultDeserializer,
  deserialize,
  takeCoverage,
  stopCoverage,
  serialize,
  writeHeapSnapshot,
  promiseHooks,
  queryObjects,
  startupSnapshot,
  setHeapSnapshotNearHeapLimit,
  GCProfiler,
  isStringOneByteRepresentation,
};

export default v8;
