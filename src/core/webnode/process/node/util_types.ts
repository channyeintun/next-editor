// Owns the `util/types` builtin module (also `util.types`). Each check is a
// brand check: it calls a built-in method or getter that only accepts objects
// with the right internal slot, so values from other realms and subclass
// instances classify as Node classifies them, and a faked `Symbol.toStringTag`
// does not fool it. Where JavaScript offers no side-effect-free brand check
// (Promise, iterators, generator objects) the check reads the built-in tag
// from the prototype that defines it.

type AnyFunction = (...args: never[]) => unknown;

const objectToString = Object.prototype.toString;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** True when calling `probe(value)` does not throw: the brand check primitive. */
function passes(probe: (value: unknown) => unknown, value: unknown): boolean {
  try {
    probe(value);
    return true;
  } catch {
    return false;
  }
}

function getter(target: object, key: PropertyKey): AnyFunction | undefined {
  return Object.getOwnPropertyDescriptor(target, key)?.get as AnyFunction | undefined;
}

function callGetter(fn: AnyFunction | undefined, value: unknown): unknown {
  return Reflect.apply(fn as AnyFunction, value, []);
}

/**
 * `Object.prototype.toString` without a `Symbol.toStringTag` in the way: the
 * built-in tag (`Error`, `Arguments`, `Date`, …) or null when an own or
 * inherited `Symbol.toStringTag` string could have changed it.
 */
function builtinTag(value: object): string | null {
  let hasTag = false;
  try {
    hasTag = typeof (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === "string";
  } catch {
    hasTag = true;
  }
  return hasTag ? null : objectToString.call(value).slice(8, -1);
}

/**
 * The value of `Symbol.toStringTag` as the prototype that owns it defines it,
 * along with that owner, or null.
 */
function ownedTag(value: object): { tag: unknown; owner: object } | null {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, Symbol.toStringTag);
    if (descriptor) {
      return { tag: descriptor.value, owner: current };
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

/** True when the tag comes from a non-writable data property, as built-in prototypes define it. */
function hasBuiltinStyleTag(value: object, tag: string): boolean {
  const found = ownedTag(value);
  if (!found || found.tag !== tag) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(found.owner, Symbol.toStringTag);
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.writable === false &&
    descriptor.enumerable === false &&
    found.owner !== value
  );
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTagGetter = getter(typedArrayPrototype, Symbol.toStringTag);
const arrayBufferByteLength = getter(ArrayBuffer.prototype, "byteLength");
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === "function"
    ? getter(SharedArrayBuffer.prototype, "byteLength")
    : undefined;
const dataViewBuffer = getter(DataView.prototype, "buffer");
const mapSize = getter(Map.prototype, "size");
const setSize = getter(Set.prototype, "size");
const regExpGlobal = getter(RegExp.prototype, "global");

/** The `Symbol.toStringTag` a typed array reports for itself (`"Uint8Array"`), or undefined. */
export function typedArrayTag(value: unknown): string | undefined {
  if (!isObjectLike(value)) {
    return undefined;
  }
  return callGetter(typedArrayTagGetter, value) as string | undefined;
}

/** `true` for a `Date` object. */
export function isDate(value: unknown): value is Date {
  return isObjectLike(value) && passes((v) => Date.prototype.getTime.call(v), value);
}

/** `true` for a `RegExp` object (not `RegExp.prototype` itself). */
export function isRegExp(value: unknown): value is RegExp {
  if (!isObjectLike(value)) {
    return false;
  }
  try {
    // The getter returns undefined for %RegExp.prototype% and throws for
    // anything without [[OriginalFlags]].
    return callGetter(regExpGlobal, value) !== undefined;
  } catch {
    return false;
  }
}

/** `true` for an object with an `[[ErrorData]]` slot (any built-in error or subclass). */
export function isNativeError(value: unknown): value is Error {
  if (!isObjectLike(value) || typeof value === "function") {
    return false;
  }
  const isError = (Error as unknown as { isError?: (v: unknown) => boolean }).isError;
  if (typeof isError === "function") {
    return isError(value);
  }
  const tag = builtinTag(value);
  if (tag !== null) {
    return tag === "Error";
  }
  return value instanceof Error;
}

/** `true` for a `Map`. */
export function isMap(value: unknown): value is Map<unknown, unknown> {
  return isObjectLike(value) && passes((v) => callGetter(mapSize, v), value);
}

/** `true` for a `Set`. */
export function isSet(value: unknown): value is Set<unknown> {
  return isObjectLike(value) && passes((v) => callGetter(setSize, v), value);
}

/** `true` for a `WeakMap`. */
export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
  return isObjectLike(value) && passes((v) => WeakMap.prototype.has.call(v as never, {}), value);
}

/** `true` for a `WeakSet`. */
export function isWeakSet(value: unknown): value is WeakSet<object> {
  return isObjectLike(value) && passes((v) => WeakSet.prototype.has.call(v as never, {}), value);
}

/**
 * `true` for a native `Promise`. There is no side-effect-free brand check for
 * promises (calling `then` would mark a rejection handled), so this accepts an
 * object whose inherited, built-in-style `Symbol.toStringTag` is "Promise" on a
 * prototype that also has `then`.
 */
export function isPromise(value: unknown): value is Promise<unknown> {
  if (!isObjectLike(value) || typeof value === "function") {
    return false;
  }
  if (!hasBuiltinStyleTag(value, "Promise")) {
    return false;
  }
  const found = ownedTag(value);
  return found !== null && typeof (found.owner as { then?: unknown }).then === "function";
}

/** `true` for an iterator from a Map (`map.entries()`, `keys()`, `values()`). */
export function isMapIterator(value: unknown): boolean {
  return isObjectLike(value) && hasBuiltinStyleTag(value, "Map Iterator");
}

/** `true` for an iterator from a Set. */
export function isSetIterator(value: unknown): boolean {
  return isObjectLike(value) && hasBuiltinStyleTag(value, "Set Iterator");
}

/** `true` for any typed array. */
export function isTypedArray(value: unknown): value is ArrayBufferView {
  return typedArrayTag(value) !== undefined;
}

/** `true` for a `Uint8Array` (including a `Buffer`). */
export function isUint8Array(value: unknown): value is Uint8Array {
  return typedArrayTag(value) === "Uint8Array";
}
/** `true` for a `Uint8ClampedArray`. */
export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray {
  return typedArrayTag(value) === "Uint8ClampedArray";
}
/** `true` for a `Uint16Array`. */
export function isUint16Array(value: unknown): value is Uint16Array {
  return typedArrayTag(value) === "Uint16Array";
}
/** `true` for a `Uint32Array`. */
export function isUint32Array(value: unknown): value is Uint32Array {
  return typedArrayTag(value) === "Uint32Array";
}
/** `true` for an `Int8Array`. */
export function isInt8Array(value: unknown): value is Int8Array {
  return typedArrayTag(value) === "Int8Array";
}
/** `true` for an `Int16Array`. */
export function isInt16Array(value: unknown): value is Int16Array {
  return typedArrayTag(value) === "Int16Array";
}
/** `true` for an `Int32Array`. */
export function isInt32Array(value: unknown): value is Int32Array {
  return typedArrayTag(value) === "Int32Array";
}
/** `true` for a `Float16Array` (false wherever the global does not exist). */
export function isFloat16Array(value: unknown): boolean {
  return typedArrayTag(value) === "Float16Array";
}
/** `true` for a `Float32Array`. */
export function isFloat32Array(value: unknown): value is Float32Array {
  return typedArrayTag(value) === "Float32Array";
}
/** `true` for a `Float64Array`. */
export function isFloat64Array(value: unknown): value is Float64Array {
  return typedArrayTag(value) === "Float64Array";
}
/** `true` for a `BigInt64Array`. */
export function isBigInt64Array(value: unknown): value is BigInt64Array {
  return typedArrayTag(value) === "BigInt64Array";
}
/** `true` for a `BigUint64Array`. */
export function isBigUint64Array(value: unknown): value is BigUint64Array {
  return typedArrayTag(value) === "BigUint64Array";
}

/** `true` for an `ArrayBuffer` (not a `SharedArrayBuffer`). */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return isObjectLike(value) && passes((v) => callGetter(arrayBufferByteLength, v), value);
}

/** `true` for a `SharedArrayBuffer`. */
export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return (
    sharedArrayBufferByteLength !== undefined &&
    isObjectLike(value) &&
    passes((v) => callGetter(sharedArrayBufferByteLength, v), value)
  );
}

/** `true` for an `ArrayBuffer` or a `SharedArrayBuffer`. */
export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
  return isArrayBuffer(value) || isSharedArrayBuffer(value);
}

/** `true` for a typed array or a `DataView`. */
export function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

/** `true` for a `DataView`. */
export function isDataView(value: unknown): value is DataView {
  return isObjectLike(value) && passes((v) => callGetter(dataViewBuffer, v), value);
}

function functionTag(value: unknown): string | null {
  if (typeof value !== "function") {
    return null;
  }
  const found = ownedTag(value);
  return found && typeof found.tag === "string" ? found.tag : null;
}

/** `true` for an `async function` or `async function*`. */
export function isAsyncFunction(value: unknown): boolean {
  const tag = functionTag(value);
  return tag === "AsyncFunction" || tag === "AsyncGeneratorFunction";
}

/** `true` for a `function*` or `async function*`. */
export function isGeneratorFunction(value: unknown): boolean {
  const tag = functionTag(value);
  return tag === "GeneratorFunction" || tag === "AsyncGeneratorFunction";
}

/** `true` for the object a generator function returns. */
export function isGeneratorObject(value: unknown): boolean {
  return (
    isObjectLike(value) &&
    typeof value !== "function" &&
    (hasBuiltinStyleTag(value, "Generator") || hasBuiltinStyleTag(value, "AsyncGenerator"))
  );
}

/** `true` for `new Number(…)`. */
export function isNumberObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    passes((v) => Number.prototype.valueOf.call(v), value)
  );
}
/** `true` for `new String(…)`. */
export function isStringObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    passes((v) => String.prototype.valueOf.call(v), value)
  );
}
/** `true` for `new Boolean(…)`. */
export function isBooleanObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    passes((v) => Boolean.prototype.valueOf.call(v), value)
  );
}
/** `true` for `Object(1n)`. */
export function isBigIntObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    passes((v) => BigInt.prototype.valueOf.call(v), value)
  );
}
/** `true` for `Object(Symbol())`. */
export function isSymbolObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    passes((v) => Symbol.prototype.valueOf.call(v), value)
  );
}
/** `true` for any boxed primitive. */
export function isBoxedPrimitive(value: unknown): boolean {
  return (
    isNumberObject(value) ||
    isStringObject(value) ||
    isBooleanObject(value) ||
    isBigIntObject(value) ||
    isSymbolObject(value)
  );
}

/** `true` for an ES module namespace object (`import * as ns`). */
export function isModuleNamespaceObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
  return (
    descriptor !== undefined &&
    descriptor.value === "Module" &&
    descriptor.writable === false &&
    descriptor.enumerable === false &&
    descriptor.configurable === false &&
    Object.getPrototypeOf(value) === null &&
    !Object.isExtensible(value)
  );
}

/** `true` for a function's `arguments` object. */
export function isArgumentsObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const tag = builtinTag(value);
  if (tag !== null) {
    return tag === "Arguments";
  }
  // A `Symbol.toStringTag` hides the built-in tag; arguments objects still
  // carry a non-enumerable own `callee`.
  const callee = Object.getOwnPropertyDescriptor(value, "callee");
  return (
    callee !== undefined &&
    !callee.enumerable &&
    !Array.isArray(value) &&
    typeof (value as { length?: unknown }).length === "number"
  );
}

/**
 * `true` for a Proxy in Node. A page cannot tell a Proxy from its target, so
 * this always returns false here.
 */
export function isProxy(_value: unknown): boolean {
  return false;
}

/** `true` for a native `External` handle in Node; JavaScript never sees one, so false. */
export function isExternal(_value: unknown): boolean {
  return false;
}

/** `true` for a WebCrypto `CryptoKey`. */
export function isCryptoKey(value: unknown): boolean {
  const CryptoKeyClass = (globalThis as { CryptoKey?: new () => unknown }).CryptoKey;
  if (typeof CryptoKeyClass !== "function" || !isObjectLike(value)) {
    return false;
  }
  return value instanceof CryptoKeyClass;
}

/** `true` for a `crypto.KeyObject` in Node; this runtime has no native KeyObject, so false. */
export function isKeyObject(_value: unknown): boolean {
  return false;
}

/** The `util/types` module object, in Node's export order. */
const types = {
  isArgumentsObject,
  isArrayBuffer,
  isAsyncFunction,
  isBigIntObject,
  isBooleanObject,
  isDate,
  isExternal,
  isGeneratorFunction,
  isGeneratorObject,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isNumberObject,
  isPromise,
  isProxy,
  isRegExp,
  isSet,
  isSetIterator,
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isWeakMap,
  isWeakSet,
  isAnyArrayBuffer,
  isBoxedPrimitive,
  isArrayBufferView,
  isDataView,
  isTypedArray,
  isUint8Array,
  isUint8ClampedArray,
  isUint16Array,
  isUint32Array,
  isInt8Array,
  isInt16Array,
  isInt32Array,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isBigInt64Array,
  isBigUint64Array,
  isKeyObject,
  isCryptoKey,
};

export default types;
