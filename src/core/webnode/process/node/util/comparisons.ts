// Owns deep equality: Node's comparison algorithm
// (lib/internal/util/comparisons.js) behind `util.isDeepStrictEqual`,
// `assert.deepEqual` and `assert.deepStrictEqual`. Strict mode compares
// prototypes, own enumerable symbols and uses Object.is for primitives; loose
// mode uses `==` for primitives and ignores prototypes.
import {
  isAnyArrayBuffer,
  isArrayBufferView,
  isBigIntObject,
  isBooleanObject,
  isBoxedPrimitive,
  isCryptoKey,
  isDate,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isMap,
  isNativeError,
  isNumberObject,
  isRegExp,
  isSet,
  isStringObject,
  isSymbolObject,
  typedArrayTag,
} from "../util_types";

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

type IterationType = typeof kNoIterator | typeof kIsArray | typeof kIsSet | typeof kIsMap;

interface Memos {
  val1: Map<object, number>;
  val2: Map<object, number>;
  position: number;
}

type AnyRecord = Record<PropertyKey, unknown>;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const isEnumerable = (value: object, key: PropertyKey): boolean =>
  Object.prototype.propertyIsEnumerable.call(value, key);

function isArrayIndex(key: string): boolean {
  if (key.length === 0 || key.length > 10) {
    return false;
  }
  if (key !== "0" && (key[0] === "0" || !/^\d+$/.test(key))) {
    return false;
  }
  return Number(key) < 2 ** 32 - 1;
}

/** Own enumerable keys that are not array indices; symbols only when `withSymbols`. */
function getOwnNonIndexProperties(value: object, withSymbols: boolean): PropertyKey[] {
  const keys: PropertyKey[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      if (withSymbols && isEnumerable(value, key)) {
        keys.push(key);
      }
    } else if (!isArrayIndex(key) && isEnumerable(value, key)) {
      keys.push(key);
    }
  }
  return keys;
}

function compareBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function areSimilarRegExps(a: RegExp, b: RegExp): boolean {
  return a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;
}

function areSimilarFloatArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function areSimilarTypedArrays(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return compareBytes(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
  );
}

function areEqualArrayBuffers(a: ArrayBufferLike, b: ArrayBufferLike): boolean {
  return a.byteLength === b.byteLength && compareBytes(new Uint8Array(a), new Uint8Array(b));
}

function isEqualBoxedPrimitive(val1: object, val2: object): boolean {
  if (isNumberObject(val1)) {
    return (
      isNumberObject(val2) &&
      Object.is(Number.prototype.valueOf.call(val1), Number.prototype.valueOf.call(val2))
    );
  }
  if (isStringObject(val1)) {
    return (
      isStringObject(val2) &&
      String.prototype.valueOf.call(val1) === String.prototype.valueOf.call(val2)
    );
  }
  if (isBooleanObject(val1)) {
    return (
      isBooleanObject(val2) &&
      Boolean.prototype.valueOf.call(val1) === Boolean.prototype.valueOf.call(val2)
    );
  }
  if (isBigIntObject(val1)) {
    return (
      isBigIntObject(val2) &&
      BigInt.prototype.valueOf.call(val1) === BigInt.prototype.valueOf.call(val2)
    );
  }
  if (isSymbolObject(val1)) {
    return (
      isSymbolObject(val2) &&
      Symbol.prototype.valueOf.call(val1) === Symbol.prototype.valueOf.call(val2)
    );
  }
  return false;
}

function isErrorLike(value: object): boolean {
  return isNativeError(value) || value instanceof Error;
}

function innerDeepEqual(
  val1: unknown,
  val2: unknown,
  strict: boolean,
  memos: Memos | undefined,
): boolean {
  if (val1 === val2) {
    return val1 !== 0 || !strict || Object.is(val1, val2);
  }
  if (strict) {
    if (typeof val1 !== "object") {
      return typeof val1 === "number" && Number.isNaN(val1) && Number.isNaN(val2);
    }
    if (typeof val2 !== "object" || val1 === null || val2 === null) {
      return false;
    }
    if (Object.getPrototypeOf(val1) !== Object.getPrototypeOf(val2)) {
      return false;
    }
  } else {
    if (val1 === null || typeof val1 !== "object") {
      if (val2 === null || typeof val2 !== "object") {
        // eslint-disable-next-line eqeqeq
        return val1 == val2 || (Number.isNaN(val1) && Number.isNaN(val2));
      }
      return false;
    }
    if (val2 === null || typeof val2 !== "object") {
      return false;
    }
  }
  const a = val1 as AnyRecord;
  const b = val2 as AnyRecord;
  const val1Tag = Object.prototype.toString.call(a);
  const val2Tag = Object.prototype.toString.call(b);
  if (val1Tag !== val2Tag) {
    return false;
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    const keys1 = getOwnNonIndexProperties(a, strict);
    const keys2 = getOwnNonIndexProperties(b, strict);
    if (keys1.length !== keys2.length) {
      return false;
    }
    return keyCheck(a, b, strict, memos, kIsArray, keys1);
  } else if (val1Tag === "[object Object]") {
    return keyCheck(a, b, strict, memos, kNoIterator);
  } else if (isDate(a)) {
    if (!isDate(b)) {
      return false;
    }
    const time1 = Date.prototype.getTime.call(a);
    const time2 = Date.prototype.getTime.call(b);
    if (time1 !== time2 && !(Number.isNaN(time1) && Number.isNaN(time2))) {
      return false;
    }
  } else if (isRegExp(a)) {
    if (!isRegExp(b) || !areSimilarRegExps(a, b)) {
      return false;
    }
  } else if (isErrorLike(a)) {
    if (!isErrorLike(b)) {
      return false;
    }
    const message1Enumerable = isEnumerable(a, "message");
    const name1Enumerable = isEnumerable(a, "name");
    const cause1Enumerable = isEnumerable(a, "cause");
    const errors1Enumerable = isEnumerable(a, "errors");
    if (
      message1Enumerable !== isEnumerable(b, "message") ||
      (!message1Enumerable && a.message !== b.message) ||
      name1Enumerable !== isEnumerable(b, "name") ||
      (!name1Enumerable && a.name !== b.name) ||
      cause1Enumerable !== isEnumerable(b, "cause") ||
      (!cause1Enumerable &&
        (hasOwn(a, "cause") !== hasOwn(b, "cause") ||
          !innerDeepEqual(a.cause, b.cause, strict, memos))) ||
      errors1Enumerable !== isEnumerable(b, "errors") ||
      (!errors1Enumerable && !innerDeepEqual(a.errors, b.errors, strict, memos))
    ) {
      return false;
    }
  } else if (isArrayBufferView(a)) {
    if (!isArrayBufferView(b) || typedArrayTag(a) !== typedArrayTag(b)) {
      return false;
    }
    if (!strict && (isFloat16Array(a) || isFloat32Array(a) || isFloat64Array(a))) {
      if (!areSimilarFloatArrays(a as unknown as number[], b as unknown as number[])) {
        return false;
      }
    } else if (!areSimilarTypedArrays(a, b)) {
      return false;
    }
    const keys1 = getOwnNonIndexProperties(a, strict);
    const keys2 = getOwnNonIndexProperties(b, strict);
    if (keys1.length !== keys2.length) {
      return false;
    }
    return keyCheck(a, b, strict, memos, kNoIterator, keys1);
  } else if (isSet(a)) {
    if (!isSet(b) || a.size !== b.size) {
      return false;
    }
    return keyCheck(a, b, strict, memos, kIsSet);
  } else if (isMap(a)) {
    if (!isMap(b) || a.size !== b.size) {
      return false;
    }
    return keyCheck(a, b, strict, memos, kIsMap);
  } else if (isAnyArrayBuffer(a)) {
    if (!isAnyArrayBuffer(b) || !areEqualArrayBuffers(a, b)) {
      return false;
    }
  } else if (isBoxedPrimitive(a)) {
    if (!isEqualBoxedPrimitive(a, b)) {
      return false;
    }
  } else if (
    Array.isArray(b) ||
    isArrayBufferView(b) ||
    isSet(b) ||
    isMap(b) ||
    isDate(b) ||
    isRegExp(b) ||
    isAnyArrayBuffer(b) ||
    isBoxedPrimitive(b) ||
    isErrorLike(b)
  ) {
    return false;
  } else if (isCryptoKey(a)) {
    // The key material is not readable synchronously; compare what is visible.
    const k1 = a as unknown as CryptoKey;
    const k2 = b as unknown as CryptoKey;
    if (
      !isCryptoKey(b) ||
      k1.type !== k2.type ||
      k1.extractable !== k2.extractable ||
      !innerDeepEqual(k1.algorithm, k2.algorithm, strict, memos) ||
      !innerDeepEqual(k1.usages, k2.usages, strict, memos)
    ) {
      return false;
    }
  }
  return keyCheck(a, b, strict, memos, kNoIterator);
}

function keyCheck(
  val1: AnyRecord,
  val2: AnyRecord,
  strict: boolean,
  memos: Memos | undefined,
  iterationType: IterationType,
  presetKeys?: PropertyKey[],
): boolean {
  let aKeys: PropertyKey[];
  if (presetKeys === undefined) {
    aKeys = Object.keys(val1);
    const bKeys = Object.keys(val2);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
  } else {
    aKeys = presetKeys;
  }

  for (let i = 0; i < aKeys.length; i++) {
    if (!hasOwn(val2, aKeys[i])) {
      return false;
    }
  }

  if (strict && presetKeys === undefined) {
    const symbolKeysA = Object.getOwnPropertySymbols(val1);
    if (symbolKeysA.length !== 0) {
      let count = 0;
      for (const key of symbolKeysA) {
        if (isEnumerable(val1, key)) {
          if (!isEnumerable(val2, key)) {
            return false;
          }
          aKeys.push(key);
          count++;
        } else if (isEnumerable(val2, key)) {
          return false;
        }
      }
      const symbolKeysB = Object.getOwnPropertySymbols(val2);
      if (
        symbolKeysA.length !== symbolKeysB.length &&
        symbolKeysB.filter((key) => isEnumerable(val2, key)).length !== count
      ) {
        return false;
      }
    } else {
      const symbolKeysB = Object.getOwnPropertySymbols(val2);
      if (symbolKeysB.some((key) => isEnumerable(val2, key))) {
        return false;
      }
    }
  }

  if (
    aKeys.length === 0 &&
    (iterationType === kNoIterator ||
      (iterationType === kIsArray && (val1 as unknown as unknown[]).length === 0) ||
      (val1 as unknown as { size: number }).size === 0)
  ) {
    return true;
  }

  // Handle cycles: a pair already being compared further up is equal when
  // both sides were entered at the same depth.
  if (memos === undefined) {
    memos = { val1: new Map(), val2: new Map(), position: 0 };
  } else {
    const val2MemoA = memos.val1.get(val1);
    if (val2MemoA !== undefined) {
      const val2MemoB = memos.val2.get(val2);
      if (val2MemoB !== undefined) {
        return val2MemoA === val2MemoB;
      }
    }
    memos.position++;
  }
  memos.val1.set(val1, memos.position);
  memos.val2.set(val2, memos.position);
  const areEq = objEquiv(val1, val2, strict, aKeys, memos, iterationType);
  memos.val1.delete(val1);
  memos.val2.delete(val2);
  return areEq;
}

function setHasEqualElement(
  set: Set<unknown>,
  val1: unknown,
  strict: boolean,
  memo: Memos,
): boolean {
  for (const val2 of set) {
    if (innerDeepEqual(val1, val2, strict, memo)) {
      set.delete(val2);
      return true;
    }
  }
  return false;
}

// Loose equality cannot find the matching primitive for strings, numbers,
// bigints and booleans (1n == '+00001'); for those, `true` means "go hunting".
function findLooseMatchingPrimitives(prim: unknown): unknown {
  switch (typeof prim) {
    case "undefined":
      return null;
    case "object":
      return undefined;
    case "symbol":
      return false;
    case "string":
      return Number.isNaN(+prim) ? false : true;
    case "number":
      return Number.isNaN(prim) ? false : true;
  }
  return true;
}

function setMightHaveLoosePrim(a: Set<unknown>, b: Set<unknown>, prim: unknown): boolean {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null) {
    return altValue as boolean;
  }
  return b.has(altValue) && !a.has(altValue);
}

function mapMightHaveLoosePrim(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  prim: unknown,
  item: unknown,
  memo: Memos,
): boolean {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null) {
    return altValue as boolean;
  }
  const curB = b.get(altValue);
  if ((curB === undefined && !b.has(altValue)) || !innerDeepEqual(item, curB, false, memo)) {
    return false;
  }
  return !a.has(altValue) && innerDeepEqual(item, curB, false, memo);
}

function setEquiv(a: Set<unknown>, b: Set<unknown>, strict: boolean, memo: Memos): boolean {
  let set: Set<unknown> | null = null;
  for (const val of a) {
    if (typeof val === "object" && val !== null) {
      set ??= new Set();
      set.add(val);
    } else if (!b.has(val)) {
      if (strict) {
        return false;
      }
      if (!setMightHaveLoosePrim(a, b, val)) {
        return false;
      }
      set ??= new Set();
      set.add(val);
    }
  }
  if (set !== null) {
    for (const val of b) {
      if (typeof val === "object" && val !== null) {
        if (!setHasEqualElement(set, val, strict, memo)) {
          return false;
        }
      } else if (!strict && !a.has(val) && !setHasEqualElement(set, val, strict, memo)) {
        return false;
      }
    }
    return set.size === 0;
  }
  return true;
}

function mapHasEqualEntry(
  set: Set<unknown>,
  map: Map<unknown, unknown>,
  key1: unknown,
  item1: unknown,
  strict: boolean,
  memo: Memos,
): boolean {
  for (const key2 of set) {
    if (
      innerDeepEqual(key1, key2, strict, memo) &&
      innerDeepEqual(item1, map.get(key2), strict, memo)
    ) {
      set.delete(key2);
      return true;
    }
  }
  return false;
}

function mapEquiv(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  strict: boolean,
  memo: Memos,
): boolean {
  let set: Set<unknown> | null = null;
  for (const [key, item1] of a) {
    if (typeof key === "object" && key !== null) {
      set ??= new Set();
      set.add(key);
    } else {
      const item2 = b.get(key);
      if ((item2 === undefined && !b.has(key)) || !innerDeepEqual(item1, item2, strict, memo)) {
        if (strict) {
          return false;
        }
        if (!mapMightHaveLoosePrim(a, b, key, item1, memo)) {
          return false;
        }
        set ??= new Set();
        set.add(key);
      }
    }
  }
  if (set !== null) {
    for (const [key, item] of b) {
      if (typeof key === "object" && key !== null) {
        if (!mapHasEqualEntry(set, a, key, item, strict, memo)) {
          return false;
        }
      } else if (
        !strict &&
        (!a.has(key) || !innerDeepEqual(a.get(key), item, false, memo)) &&
        !mapHasEqualEntry(set, a, key, item, false, memo)
      ) {
        return false;
      }
    }
    return set.size === 0;
  }
  return true;
}

function objEquiv(
  a: AnyRecord,
  b: AnyRecord,
  strict: boolean,
  keys: PropertyKey[],
  memos: Memos,
  iterationType: IterationType,
): boolean {
  if (iterationType === kIsSet) {
    if (!setEquiv(a as unknown as Set<unknown>, b as unknown as Set<unknown>, strict, memos)) {
      return false;
    }
  } else if (iterationType === kIsMap) {
    if (
      !mapEquiv(
        a as unknown as Map<unknown, unknown>,
        b as unknown as Map<unknown, unknown>,
        strict,
        memos,
      )
    ) {
      return false;
    }
  } else if (iterationType === kIsArray) {
    const arrayA = a as unknown as unknown[];
    const arrayB = b as unknown as unknown[];
    for (let i = 0; i < arrayA.length; i++) {
      if (hasOwn(arrayA, i)) {
        if (!hasOwn(arrayB, i) || !innerDeepEqual(arrayA[i], arrayB[i], strict, memos)) {
          return false;
        }
      } else if (hasOwn(arrayB, i)) {
        return false;
      } else {
        // The array is sparse: compare the remaining own keys.
        const keysA = Object.keys(arrayA);
        for (; i < keysA.length; i++) {
          const key = keysA[i];
          if (!hasOwn(arrayB, key) || !innerDeepEqual(a[key], b[key], strict, memos)) {
            return false;
          }
        }
        return keysA.length === Object.keys(arrayB).length;
      }
    }
  }
  for (const key of keys) {
    if (!innerDeepEqual(a[key], b[key], strict, memos)) {
      return false;
    }
  }
  return true;
}

/** Node's `isDeepEqual` (loose): `assert.deepEqual`. */
export function isDeepEqual(val1: unknown, val2: unknown): boolean {
  return innerDeepEqual(val1, val2, false, undefined);
}

/** Node's `isDeepStrictEqual`: `util.isDeepStrictEqual` and `assert.deepStrictEqual`. */
export function isDeepStrictEqual(val1: unknown, val2: unknown): boolean {
  return innerDeepEqual(val1, val2, true, undefined);
}
