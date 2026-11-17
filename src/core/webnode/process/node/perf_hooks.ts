// The `perf_hooks` builtin: the browser's own `performance` and observer
// classes, plus Node's histograms. The histograms are a port of the
// HdrHistogram_c code Node links (bucketing, min/max/mean/stddev, percentile
// and the percentile iterator), so they report the same numbers Node does.
// `monitorEventLoopDelay` samples with a native interval captured when this
// module is evaluated; it never holds the process open.
import {
  invalidArgType,
  makeNodeError,
  outOfRange,
  validateFunction,
  validateInteger,
  validateNumber,
  validateObject,
} from "./internalErrors";

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativePerformance = globalThis.performance;

/** INT64_MAX: what HdrHistogram reports as the min of an empty histogram. */
const INT64_MAX = 9223372036854775807n;

function bitLength(value: number): number {
  if (value < 2 ** 32) {
    return 32 - Math.clz32(value);
  }
  return 64 - Math.clz32(Math.floor(value / 2 ** 32));
}

/** HdrHistogram_c's `hdr_histogram`, over JavaScript numbers (values up to 2^53). */
class Hdr {
  readonly lowest: number;
  readonly highest: number;
  readonly figures: number;
  private readonly unitMagnitude: number;
  private readonly subBucketHalfCountMagnitude: number;
  private readonly subBucketCount: number;
  private readonly subBucketHalfCount: number;
  private readonly subBucketMask: number;
  private readonly countsLen: number;
  counts: Float64Array;
  totalCount = 0;
  /** Infinity stands for INT64_MAX (nothing recorded yet). */
  minValue = Infinity;
  maxValue = 0;

  constructor(lowest: number, highest: number, figures: number) {
    this.lowest = lowest;
    this.highest = highest;
    this.figures = figures;
    const largestSingleUnit = 2 * 10 ** figures;
    const subBucketCountMagnitude = Math.ceil(Math.log2(largestSingleUnit));
    this.subBucketHalfCountMagnitude = Math.max(subBucketCountMagnitude, 1) - 1;
    this.unitMagnitude = Math.floor(Math.log2(lowest));
    this.subBucketCount = 2 ** (this.subBucketHalfCountMagnitude + 1);
    this.subBucketHalfCount = this.subBucketCount / 2;
    this.subBucketMask = (this.subBucketCount - 1) * 2 ** this.unitMagnitude;
    let smallestUntrackable = this.subBucketCount * 2 ** this.unitMagnitude;
    let bucketCount = 1;
    while (smallestUntrackable < highest) {
      if (smallestUntrackable > 2 ** 62) {
        bucketCount++;
        break;
      }
      smallestUntrackable *= 2;
      bucketCount++;
    }
    this.countsLen = (bucketCount + 1) * this.subBucketHalfCount;
    this.counts = new Float64Array(this.countsLen);
  }

  private bucketIndex(value: number): number {
    const pow2ceiling = Math.max(bitLength(value), bitLength(this.subBucketMask));
    return pow2ceiling - this.unitMagnitude - (this.subBucketHalfCountMagnitude + 1);
  }

  private subBucketIndex(value: number, bucketIndex: number): number {
    return Math.floor(value / 2 ** (bucketIndex + this.unitMagnitude));
  }

  private countsIndex(bucketIndex: number, subBucketIndex: number): number {
    const bucketBase = (bucketIndex + 1) * 2 ** this.subBucketHalfCountMagnitude;
    return bucketBase + (subBucketIndex - this.subBucketHalfCount);
  }

  private countsIndexFor(value: number): number {
    const bucketIndex = this.bucketIndex(value);
    return this.countsIndex(bucketIndex, this.subBucketIndex(value, bucketIndex));
  }

  valueAtIndex(index: number): number {
    let bucketIndex = Math.floor(index / 2 ** this.subBucketHalfCountMagnitude) - 1;
    let subBucketIndex = (index % this.subBucketHalfCount) + this.subBucketHalfCount;
    if (bucketIndex < 0) {
      subBucketIndex -= this.subBucketHalfCount;
      bucketIndex = 0;
    }
    return subBucketIndex * 2 ** (bucketIndex + this.unitMagnitude);
  }

  private sizeOfEquivalentRange(value: number): number {
    const bucketIndex = this.bucketIndex(value);
    const subBucketIndex = this.subBucketIndex(value, bucketIndex);
    const adjusted = subBucketIndex >= this.subBucketCount ? bucketIndex + 1 : bucketIndex;
    return 2 ** (this.unitMagnitude + adjusted);
  }

  lowestEquivalent(value: number): number {
    const bucketIndex = this.bucketIndex(value);
    return this.subBucketIndex(value, bucketIndex) * 2 ** (bucketIndex + this.unitMagnitude);
  }

  highestEquivalent(value: number): number {
    return this.lowestEquivalent(value) + this.sizeOfEquivalentRange(value) - 1;
  }

  private medianEquivalent(value: number): number {
    return this.lowestEquivalent(value) + Math.floor(this.sizeOfEquivalentRange(value) / 2);
  }

  /** `hdr_record_values`: false when `value` is outside the trackable range. */
  record(value: number, count = 1): boolean {
    if (value < 0) {
      return false;
    }
    const index = this.countsIndexFor(value);
    if (index < 0 || index >= this.countsLen) {
      return false;
    }
    this.counts[index] += count;
    this.totalCount += count;
    if (value !== 0 && value < this.minValue) {
      this.minValue = value;
    }
    if (value > this.maxValue) {
      this.maxValue = value;
    }
    return true;
  }

  reset(): void {
    this.counts.fill(0);
    this.totalCount = 0;
    this.minValue = Infinity;
    this.maxValue = 0;
  }

  /** `hdr_min`; Infinity for INT64_MAX. */
  min(): number {
    if (this.counts[0] > 0) {
      return 0;
    }
    return this.minValue === Infinity ? Infinity : this.lowestEquivalent(this.minValue);
  }

  max(): number {
    return this.maxValue === 0 ? 0 : this.highestEquivalent(this.maxValue);
  }

  /** Each recorded bucket as [value at index, count]. */
  *recorded(): Generator<[number, number]> {
    for (let i = 0; i < this.countsLen; i++) {
      if (this.counts[i] !== 0) {
        yield [this.valueAtIndex(i), this.counts[i]];
      }
    }
  }

  mean(): number {
    let total = 0;
    for (const [value, count] of this.recorded()) {
      total += count * this.medianEquivalent(value);
    }
    return total / this.totalCount;
  }

  stddev(): number {
    const mean = this.mean();
    let total = 0;
    for (const [value, count] of this.recorded()) {
      total += (this.medianEquivalent(value) - mean) ** 2 * count;
    }
    return Math.sqrt(total / this.totalCount);
  }

  /** `hdr_value_at_percentile`. */
  valueAtPercentile(percentile: number): number {
    const requested = Math.min(percentile, 100);
    const countAt = Math.max(Math.trunc((requested / 100) * this.totalCount + 0.5), 1);
    let cumulative = 0;
    let valueFromIndex = 0;
    for (let i = 0; i < this.countsLen; i++) {
      cumulative += this.counts[i];
      if (cumulative >= countAt) {
        valueFromIndex = this.valueAtIndex(i);
        break;
      }
    }
    if (percentile === 0) {
      return this.lowestEquivalent(valueFromIndex);
    }
    return this.highestEquivalent(valueFromIndex);
  }

  /** The percentile iterator with one tick per half distance, as Node's `percentiles` walks it. */
  percentiles(): [number, number][] {
    const out: [number, number][] = [];
    const total = this.totalCount;
    let countsIndex = -1;
    let count = 0;
    let cumulative = 0;
    let value = 0;
    let toIterate = 0;
    let percentile = 0;
    let seenLast = false;
    const moveNext = (): boolean => {
      countsIndex++;
      if (countsIndex >= this.countsLen) {
        return false;
      }
      count = this.counts[countsIndex];
      cumulative += count;
      value = this.valueAtIndex(countsIndex);
      return true;
    };
    const basicNext = (): boolean => cumulative < total && moveNext();
    const next = (): boolean => {
      if (!(cumulative < total)) {
        if (seenLast) {
          return false;
        }
        seenLast = true;
        percentile = 100;
        return true;
      }
      if (countsIndex === -1 && !basicNext()) {
        return false;
      }
      do {
        const current = (100 * cumulative) / total;
        if (count !== 0 && toIterate <= current) {
          percentile = toIterate;
          const temp = Math.trunc(Math.log(100 / (100 - toIterate)) / Math.log(2)) + 1;
          toIterate += 100 / 2 ** temp;
          return true;
        }
      } while (basicNext());
      return true;
    };
    while (next()) {
      out.push([percentile, value]);
    }
    return out;
  }
}

const kHdr = Symbol("kHdr");

/** Node's `Histogram`: the read side shared by every histogram. */
export class Histogram {
  /** @internal */
  [kHdr]: Hdr;
  /** @internal */
  protected recordedCount = 0;
  /** @internal */
  protected exceededCount = 0;

  /** @internal */
  constructor(hdr: Hdr) {
    this[kHdr] = hdr;
  }

  /** How many samples were recorded. */
  get count(): number {
    return this.recordedCount;
  }

  get countBigInt(): bigint {
    return BigInt(this.recordedCount);
  }

  /** Samples that were out of the histogram's range. */
  get exceeds(): number {
    return this.exceededCount;
  }

  get exceedsBigInt(): bigint {
    return BigInt(this.exceededCount);
  }

  get min(): number {
    const min = this[kHdr].min();
    return min === Infinity ? Number(INT64_MAX) : min;
  }

  get minBigInt(): bigint {
    const min = this[kHdr].min();
    return min === Infinity ? INT64_MAX : BigInt(min);
  }

  get max(): number {
    return this[kHdr].max();
  }

  get maxBigInt(): bigint {
    return BigInt(this[kHdr].max());
  }

  get mean(): number {
    return this[kHdr].mean();
  }

  get stddev(): number {
    return this[kHdr].stddev();
  }

  /** The value at `percentile` (0 < percentile <= 100). */
  percentile(percentile: number): number {
    validateNumber(percentile, "percentile");
    if (percentile <= 0 || percentile > 100) {
      throw outOfRange("percentile", "> 0 && <= 100", percentile);
    }
    return this[kHdr].valueAtPercentile(percentile);
  }

  percentileBigInt(percentile: number): bigint {
    return BigInt(this.percentile(percentile));
  }

  /** Percentile → value, as HdrHistogram's percentile iterator reports them. */
  get percentiles(): Map<number, number> {
    return new Map(this[kHdr].percentiles());
  }

  get percentilesBigInt(): Map<number, bigint> {
    return new Map(this[kHdr].percentiles().map(([p, v]) => [p, BigInt(v)]));
  }

  /** Clears every sample. */
  reset(): void {
    this[kHdr].reset();
    this.recordedCount = 0;
    this.exceededCount = 0;
    this.resetDelta();
  }

  /** @internal */
  protected resetDelta(): void {}

  /** @internal Records `value`, counting it as recorded or exceeding. */
  protected recordValue(value: number): void {
    if (this[kHdr].record(value)) {
      this.recordedCount++;
    } else {
      this.exceededCount++;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles: Object.fromEntries(this.percentiles),
    };
  }
}

function hrtimeNs(): number {
  return Math.round(nativePerformance.now() * 1e6);
}

/** Node's `RecordableHistogram`, from `createHistogram()`. */
export class RecordableHistogram extends Histogram {
  private previous = 0;

  /** Records one sample: an integer >= 1 (number or bigint). */
  record(value: number | bigint): void {
    if (typeof value === "bigint") {
      this.recordValue(Number(value));
      return;
    }
    validateInteger(value, "val", 1);
    this.recordValue(value);
  }

  /** Records the nanoseconds since the previous `recordDelta()` call. */
  recordDelta(): void {
    const time = hrtimeNs();
    if (this.previous > 0) {
      const delta = time - this.previous;
      if (delta > 0) {
        this.recordValue(delta);
      }
    }
    this.previous = time;
  }

  /** Adds every sample of `other`. */
  add(other: RecordableHistogram): void {
    if (!(other instanceof RecordableHistogram)) {
      throw invalidArgType("other", "RecordableHistogram", other);
    }
    this.recordedCount += other.recordedCount;
    this.exceededCount += other.exceededCount;
    for (const [value, count] of other[kHdr].recorded()) {
      this[kHdr].record(value, count);
    }
  }

  protected override resetDelta(): void {
    this.previous = 0;
  }
}

/** Node's `IntervalHistogram`, from `monitorEventLoopDelay()`. */
export class IntervalHistogram extends Histogram {
  private readonly resolution: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private previous = 0;

  /** @internal */
  constructor(hdr: Hdr, resolution: number) {
    super(hdr);
    this.resolution = resolution;
  }

  /** Starts sampling; false when it already was. */
  enable(): boolean {
    if (this.timer !== null) {
      return false;
    }
    this.previous = 0;
    const timer = nativeSetInterval(() => this.sample(), this.resolution);
    // A Node test host's interval would keep the test process alive; a
    // browser's interval never holds a webnode process open.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
    return true;
  }

  /** Stops sampling; false when it was not sampling. */
  disable(): boolean {
    if (this.timer === null) {
      return false;
    }
    nativeClearInterval(this.timer);
    this.timer = null;
    return true;
  }

  [Symbol.dispose](): void {
    this.disable();
  }

  private sample(): void {
    const time = hrtimeNs();
    if (this.previous > 0) {
      const delta = time - this.previous;
      if (delta > 0) {
        this.recordValue(delta);
      }
    }
    this.previous = time;
  }

  protected override resetDelta(): void {
    this.previous = 0;
  }
}

/** `perf_hooks.createHistogram([options])`. */
export function createHistogram(
  options: { lowest?: number | bigint; highest?: number | bigint; figures?: number } = {},
): RecordableHistogram {
  validateObject(options, "options");
  const { lowest = 1, highest = Number.MAX_SAFE_INTEGER, figures = 3 } = options;
  if (typeof lowest !== "bigint") {
    validateInteger(lowest, "options.lowest", 1, Number.MAX_SAFE_INTEGER);
  }
  if (typeof highest !== "bigint") {
    validateInteger(highest, "options.highest", 2 * Number(lowest), Number.MAX_SAFE_INTEGER);
  } else if (highest < 2n * BigInt(lowest)) {
    throw makeNodeError(
      "ERR_INVALID_ARG_VALUE",
      `The property 'options.highest' is invalid. Received ${highest}n`,
      RangeError,
    );
  }
  validateInteger(figures, "options.figures", 1, 5);
  return new RecordableHistogram(new Hdr(Number(lowest), Number(highest), figures));
}

/** `perf_hooks.monitorEventLoopDelay([options])`: samples every `resolution` ms once enabled. */
export function monitorEventLoopDelay(options: { resolution?: number } = {}): IntervalHistogram {
  validateObject(options, "options");
  const { resolution = 10 } = options;
  validateInteger(resolution, "options.resolution", 1);
  return new IntervalHistogram(new Hdr(1, Number.MAX_SAFE_INTEGER, 3), resolution);
}

/** `performance.eventLoopUtilization()`'s result. */
export interface EventLoopUtilization {
  idle: number;
  active: number;
  utilization: number;
}

/**
 * `performance.eventLoopUtilization()`. A browser does not report how long its
 * event loop sat idle, so every figure is 0 (what Node reports before the loop
 * starts). A documented exception to "throw what the browser cannot do":
 * callers such as Vite read it unconditionally and crash without it.
 */
function eventLoopUtilization(
  _utilization1?: EventLoopUtilization,
  _utilization2?: EventLoopUtilization,
): EventLoopUtilization {
  return { idle: 0, active: 0, utilization: 0 };
}

const timerified = new WeakMap<object, unknown>();

/**
 * `performance.timerify(fn[, options])`: wraps `fn` and records each call's
 * duration (ns) into `options.histogram`. The browser's PerformanceObserver
 * cannot be fed custom entries, so no `function` entry is delivered.
 */
function timerify<T extends (...args: never[]) => unknown>(
  fn: T,
  options: { histogram?: RecordableHistogram } = {},
): T {
  validateFunction(fn, "fn");
  validateObject(options, "options");
  const { histogram } = options;
  if (histogram !== undefined && !(histogram instanceof RecordableHistogram)) {
    throw invalidArgType("options.histogram", "RecordableHistogram", histogram);
  }
  const cached = timerified.get(fn);
  if (cached !== undefined) {
    return cached as T;
  }
  const complete = (start: number) => {
    histogram?.record(Math.max(1, Math.ceil((nativePerformance.now() - start) * 1e6)));
  };
  function wrapped(this: unknown, ...args: unknown[]): unknown {
    const start = nativePerformance.now();
    const result: unknown = new.target
      ? Reflect.construct(fn, args, fn)
      : Reflect.apply(fn, this, args);
    if (!new.target && typeof (result as Promise<unknown> | null)?.finally === "function") {
      return (result as Promise<unknown>).finally(() => complete(start));
    }
    complete(start);
    return result;
  }
  Object.defineProperties(wrapped, {
    length: { configurable: false, enumerable: true, value: fn.length },
    name: { configurable: false, enumerable: true, value: `timerified ${fn.name}` },
  });
  timerified.set(fn, wrapped);
  return wrapped as unknown as T;
}

const extras: Record<string | symbol, unknown> = { eventLoopUtilization, timerify };
const bound = new Map<string | symbol, unknown>();

/**
 * `perf_hooks.performance`: the global `performance` (marks, measures,
 * `now()`, `timeOrigin` are the browser's own) with Node's
 * `eventLoopUtilization` and `timerify` added.
 */
export const performance = new Proxy(nativePerformance, {
  get(target, key) {
    if (Object.hasOwn(extras, key)) {
      return extras[key];
    }
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function") {
      return value;
    }
    let method = bound.get(key);
    if (method === undefined) {
      method = (value as (...args: unknown[]) => unknown).bind(target);
      bound.set(key, method);
    }
    return method;
  },
  has(target, key) {
    return Object.hasOwn(extras, key) || Reflect.has(target, key);
  },
}) as Performance & {
  eventLoopUtilization: typeof eventLoopUtilization;
  timerify: typeof timerify;
};

/** `perf_hooks.constants`. */
export const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
});

const globals = globalThis as unknown as Record<string, unknown>;

/** The browser's observer and entry classes (undefined where a browser lacks one). */
export const Performance = globals.Performance;
export const PerformanceEntry = globals.PerformanceEntry;
export const PerformanceMark = globals.PerformanceMark;
export const PerformanceMeasure = globals.PerformanceMeasure;
export const PerformanceObserver = globals.PerformanceObserver;
export const PerformanceObserverEntryList = globals.PerformanceObserverEntryList;
export const PerformanceResourceTiming = globals.PerformanceResourceTiming;

const perfHooks = {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  monitorEventLoopDelay,
  createHistogram,
  performance,
  constants,
};

export default perfHooks;
