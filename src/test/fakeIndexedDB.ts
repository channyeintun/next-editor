/**
 * A small in-memory IndexedDB for unit tests (jsdom has none, and the repo takes
 * no dependency for one). It implements the part of the API the storage modules
 * use, with the semantics their correctness depends on:
 *
 * - requests of one transaction run in order, one per macrotask, and each
 *   success/error handler (plus the microtasks it queues) runs before the next;
 * - a transaction is active only while it is being created or while a request
 *   callback runs, so a request made after awaiting unrelated work throws
 *   TransactionInactiveError, as in a browser;
 * - a transaction commits once no request is pending, and a failed request
 *   (not preventDefault()ed) aborts it and rolls back every write it made;
 * - stored values are copied on write and on read (Blobs are shared, as they
 *   are immutable).
 *
 * Keys may be numbers, strings or arrays of those (compared as IndexedDB does);
 * object stores may use an inline key path (string or array) or out-of-line keys.
 */

type Key = number | string | Key[];

interface StoredRecord {
  key: Key;
  value: unknown;
}

interface StoreData {
  keyPath: string | string[] | null;
  records: StoredRecord[];
}

interface DatabaseData {
  version: number;
  stores: Map<string, StoreData>;
}

type Handler = ((event: FakeEvent) => void) | null;

interface FakeEvent {
  type: string;
  target: unknown;
  oldVersion?: number;
  newVersion?: number;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function createEvent(type: string, target: unknown, extra: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    type,
    target,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...extra,
  };
  return event;
}

function keyTypeRank(key: Key): number {
  if (typeof key === "number") return 0;
  if (typeof key === "string") return 1;
  return 2;
}

export function compareKeys(left: Key, right: Key): number {
  const rankDifference = keyTypeRank(left) - keyTypeRank(right);
  if (rankDifference !== 0) return Math.sign(rankDifference);
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const difference = compareKeys(left[index], right[index]);
      if (difference !== 0) return difference;
    }
    return Math.sign(left.length - right.length);
  }
  if (left === right) return 0;
  return (left as number | string) < (right as number | string) ? -1 : 1;
}

function isKey(value: unknown): value is Key {
  if (typeof value === "number") return !Number.isNaN(value);
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every(isKey);
}

function toKey(value: unknown): Key {
  if (!isKey(value)) throw new DOMException("The key is not a valid key", "DataError");
  return value;
}

export class FakeKeyRange {
  readonly lower: Key | undefined;
  readonly upper: Key | undefined;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;

  constructor(
    lower: Key | undefined,
    upper: Key | undefined,
    lowerOpen = false,
    upperOpen = false,
  ) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  static only(value: unknown): FakeKeyRange {
    const key = toKey(value);
    return new FakeKeyRange(key, key);
  }

  static bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(toKey(lower), toKey(upper), lowerOpen, upperOpen);
  }

  static lowerBound(lower: unknown, open = false): FakeKeyRange {
    return new FakeKeyRange(toKey(lower), undefined, open, false);
  }

  static upperBound(upper: unknown, open = false): FakeKeyRange {
    return new FakeKeyRange(undefined, toKey(upper), false, open);
  }

  includes(key: Key): boolean {
    if (this.lower !== undefined) {
      const comparison = compareKeys(key, this.lower);
      if (comparison < 0 || (comparison === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const comparison = compareKeys(key, this.upper);
      if (comparison > 0 || (comparison === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

function matches(query: unknown, key: Key): boolean {
  if (query === undefined || query === null) return true;
  if (query instanceof FakeKeyRange) return query.includes(key);
  return compareKeys(toKey(query), key) === 0;
}

/** Copies a value the way structured clone would, except that Blobs are shared. */
function copyValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { slice(): unknown };
    return view.slice();
  }
  if (Array.isArray(value)) return value.map(copyValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
      name,
      copyValue(entry),
    ]),
  );
}

function extractKey(value: unknown, keyPath: string | string[]): Key {
  const read = (path: string) => (value as Record<string, unknown>)[path];
  return toKey(Array.isArray(keyPath) ? keyPath.map(read) : read(keyPath));
}

/** A fault to inject: the next matching request fails with `error`. */
export interface FakeIndexedDBFault {
  store: string;
  method: "put" | "delete" | "clear" | "get" | "getAll" | "getAllKeys";
  error: DOMException;
}

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: Handler = null;
  onerror: Handler = null;
  readonly source: unknown;
  transaction: FakeTransaction | null;

  constructor(source: unknown, transaction: FakeTransaction | null) {
    this.source = source;
    this.transaction = transaction;
  }
}

class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

interface QueuedOperation {
  request: FakeRequest;
  run: () => unknown;
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private readonly queue: QueuedOperation[] = [];
  private active = true;
  private finished = false;
  private stepScheduled = false;
  private readonly snapshot: Map<string, StoredRecord[]>;
  readonly db: FakeDatabase;
  readonly scope: string[] | null;
  readonly mode: IDBTransactionMode | "versionchange";

  constructor(
    db: FakeDatabase,
    scope: string[] | null,
    mode: IDBTransactionMode | "versionchange",
  ) {
    this.db = db;
    this.scope = scope;
    this.mode = mode;
    this.snapshot = new Map(
      (scope ?? []).map((name) => [name, [...db.data.stores.get(name)!.records]]),
    );
    setTimeout(() => {
      this.active = false;
      this.scheduleStep();
    }, 0);
  }

  objectStore(name: string): FakeObjectStore {
    if (this.finished) throw new DOMException("The transaction has finished", "InvalidStateError");
    if (this.scope && !this.scope.includes(name)) {
      throw new DOMException(`${name} is not in this transaction`, "NotFoundError");
    }
    const data = this.db.data.stores.get(name);
    if (!data) throw new DOMException(`No object store named ${name}`, "NotFoundError");
    return new FakeObjectStore(this, name, data);
  }

  enqueue(source: unknown, run: () => unknown, request = new FakeRequest(source, this)) {
    if (this.finished || !this.active) {
      throw new DOMException("The transaction is not active", "TransactionInactiveError");
    }
    request.readyState = "pending";
    this.queue.push({ request, run });
    return request;
  }

  assertWritable(): void {
    if (this.mode === "readonly") {
      throw new DOMException("The transaction is read-only", "ReadOnlyError");
    }
  }

  private scheduleStep(): void {
    if (this.stepScheduled || this.finished) return;
    this.stepScheduled = true;
    setTimeout(() => {
      this.stepScheduled = false;
      this.step();
    }, 0);
  }

  private step(): void {
    if (this.finished) return;
    const next = this.queue.shift();
    if (!next) {
      this.commit();
      return;
    }
    const { request, run } = next;
    this.active = true;
    try {
      request.result = run();
      request.readyState = "done";
      request.onsuccess?.(createEvent("success", request));
    } catch (caught) {
      const error =
        caught instanceof DOMException ? caught : new DOMException(String(caught), "UnknownError");
      request.error = error;
      request.readyState = "done";
      const event = createEvent("error", request);
      request.onerror?.(event);
      if (!event.defaultPrevented) {
        // As in a browser, the error bubbles to the transaction before the abort
        // sets transaction.error, so onerror still sees error === null.
        this.onerror?.(event);
        queueMicrotask(() => this.abort(error));
        return;
      }
    }
    // Microtasks queued by the handler run before this macrotask ends the active window.
    setTimeout(() => {
      this.active = false;
      this.scheduleStep();
    }, 0);
  }

  private commit(): void {
    const commitFault = this.mode === "readwrite" ? this.db.owner.takeCommitFault() : undefined;
    if (commitFault) {
      // What a browser does when the disk write fails, e.g. over quota: every
      // request succeeded, and the transaction aborts instead of completing.
      this.abort(commitFault);
      return;
    }
    this.finished = true;
    this.oncomplete?.(createEvent("complete", this));
  }

  abort(error: DOMException | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    for (const [name, records] of this.snapshot) {
      this.db.data.stores.get(name)!.records = records;
    }
    for (const { request } of this.queue.splice(0)) {
      request.error = new DOMException("The transaction was aborted", "AbortError");
      request.readyState = "done";
      request.onerror?.(createEvent("error", request));
    }
    this.onabort?.(createEvent("abort", this));
  }
}

class FakeCursor {
  private readonly request: FakeRequest;
  private readonly transaction: FakeTransaction;
  private readonly advance: () => FakeCursor | null;
  readonly key: Key;
  readonly value: unknown;

  constructor(
    request: FakeRequest,
    transaction: FakeTransaction,
    advance: () => FakeCursor | null,
    key: Key,
    value: unknown,
  ) {
    this.request = request;
    this.transaction = transaction;
    this.advance = advance;
    this.key = key;
    this.value = value;
  }

  get primaryKey(): Key {
    return this.key;
  }

  continue(): void {
    this.transaction.enqueue(null, this.advance, this.request);
  }
}

class FakeObjectStore {
  private readonly transaction: FakeTransaction;
  readonly name: string;
  private readonly data: StoreData;

  constructor(transaction: FakeTransaction, name: string, data: StoreData) {
    this.transaction = transaction;
    this.name = name;
    this.data = data;
  }

  get keyPath(): string | string[] | null {
    return this.data.keyPath;
  }

  private request(method: FakeIndexedDBFault["method"], run: () => unknown): FakeRequest {
    const fakeIndexedDB = this.transaction.db.owner;
    return this.transaction.enqueue(this, () => {
      fakeIndexedDB.throwInjectedFault(this.name, method);
      return run();
    });
  }

  get(query: unknown): FakeRequest {
    return this.request("get", () => {
      const record = this.data.records.find((entry) => matches(query, entry.key));
      return record ? copyValue(record.value) : undefined;
    });
  }

  getAll(query?: unknown): FakeRequest {
    return this.request("getAll", () =>
      this.data.records
        .filter((entry) => matches(query, entry.key))
        .map((entry) => copyValue(entry.value)),
    );
  }

  getAllKeys(query?: unknown): FakeRequest {
    return this.request("getAllKeys", () =>
      this.data.records.filter((entry) => matches(query, entry.key)).map((entry) => entry.key),
    );
  }

  put(value: unknown, key?: unknown): FakeRequest {
    this.transaction.assertWritable();
    const resolvedKey = this.data.keyPath ? extractKey(value, this.data.keyPath) : toKey(key);
    const stored = copyValue(value);
    return this.request("put", () => {
      const records = this.data.records.filter(
        (entry) => compareKeys(entry.key, resolvedKey) !== 0,
      );
      records.push({ key: resolvedKey, value: stored });
      records.sort((left, right) => compareKeys(left.key, right.key));
      this.data.records = records;
      return resolvedKey;
    });
  }

  delete(query: unknown): FakeRequest {
    this.transaction.assertWritable();
    return this.request("delete", () => {
      this.data.records = this.data.records.filter((entry) => !matches(query, entry.key));
      return undefined;
    });
  }

  clear(): FakeRequest {
    this.transaction.assertWritable();
    return this.request("clear", () => {
      this.data.records = [];
      return undefined;
    });
  }

  openCursor(query?: unknown): FakeRequest {
    const request = new FakeRequest(this, this.transaction);
    let lastKey: Key | undefined;
    const advance = (): FakeCursor | null => {
      // Re-read the records on each step: the cursor sees writes made meanwhile.
      const next = this.data.records.find(
        (entry) =>
          matches(query, entry.key) &&
          (lastKey === undefined || compareKeys(entry.key, lastKey) > 0),
      );
      if (!next) return null;
      lastKey = next.key;
      return new FakeCursor(request, this.transaction, advance, next.key, copyValue(next.value));
    };
    return this.transaction.enqueue(this, advance, request);
  }
}

class FakeDatabase {
  closed = false;
  onversionchange: Handler = null;
  upgradeTransaction: FakeTransaction | null = null;

  readonly owner: FakeIndexedDB;
  readonly name: string;
  readonly data: DatabaseData;

  constructor(owner: FakeIndexedDB, name: string, data: DatabaseData) {
    this.owner = owner;
    this.name = name;
    this.data = data;
  }

  get version(): number {
    return this.data.version;
  }

  get objectStoreNames() {
    const names = [...this.data.stores.keys()].sort();
    return {
      length: names.length,
      contains: (name: string) => this.data.stores.has(name),
      item: (index: number) => names[index] ?? null,
    };
  }

  createObjectStore(name: string, options: { keyPath?: string | string[] } = {}) {
    if (!this.upgradeTransaction) {
      throw new DOMException("Not in a versionchange transaction", "InvalidStateError");
    }
    if (this.data.stores.has(name)) {
      throw new DOMException(`Object store ${name} already exists`, "ConstraintError");
    }
    this.data.stores.set(name, { keyPath: options.keyPath ?? null, records: [] });
    return this.upgradeTransaction.objectStore(name);
  }

  deleteObjectStore(name: string): void {
    if (!this.upgradeTransaction) {
      throw new DOMException("Not in a versionchange transaction", "InvalidStateError");
    }
    if (!this.data.stores.delete(name)) {
      throw new DOMException(`No object store named ${name}`, "NotFoundError");
    }
  }

  transaction(names: string | string[], mode: IDBTransactionMode = "readonly"): FakeTransaction {
    if (this.closed) throw new DOMException("The connection is closed", "InvalidStateError");
    const scope = Array.isArray(names) ? names : [names];
    for (const name of scope) {
      if (!this.data.stores.has(name)) {
        throw new DOMException(`No object store named ${name}`, "NotFoundError");
      }
    }
    return new FakeTransaction(this, scope, mode);
  }

  close(): void {
    this.closed = true;
    this.owner.connections.delete(this);
  }
}

export interface SeedStore {
  keyPath?: string | string[];
  /** Inline-key stores take values; out-of-line stores take `{ key, value }`. */
  records: unknown[];
}

export class FakeIndexedDB {
  readonly databases = new Map<string, DatabaseData>();
  readonly connections = new Set<FakeDatabase>();
  private readonly faults: FakeIndexedDBFault[] = [];
  private readonly commitFaults: DOMException[] = [];

  /** Pass to `vi.stubGlobal("indexedDB", ...)`. */
  readonly indexedDB = { open: (name: string, version?: number) => this.open(name, version) };

  /** Pass to `vi.stubGlobal("IDBKeyRange", ...)`. */
  readonly IDBKeyRange = FakeKeyRange;

  /** Makes the next request matching `fault.store` and `fault.method` fail. */
  failNext(fault: FakeIndexedDBFault): void {
    this.faults.push(fault);
  }

  /** Makes the next readwrite transaction abort with `error` when it would commit. */
  failNextCommit(error: DOMException): void {
    this.commitFaults.push(error);
  }

  takeCommitFault(): DOMException | undefined {
    return this.commitFaults.shift();
  }

  throwInjectedFault(store: string, method: FakeIndexedDBFault["method"]): void {
    const index = this.faults.findIndex(
      (fault) => fault.store === store && fault.method === method,
    );
    if (index === -1) return;
    const [fault] = this.faults.splice(index, 1);
    throw fault.error;
  }

  /** Creates a database as an older build would have left it. */
  seed(name: string, version: number, stores: Record<string, SeedStore>): void {
    const data: DatabaseData = { version, stores: new Map() };
    for (const [storeName, seedStore] of Object.entries(stores)) {
      const keyPath = seedStore.keyPath ?? null;
      const records = seedStore.records.map((record) =>
        keyPath
          ? { key: extractKey(record, keyPath), value: copyValue(record) }
          : {
              key: toKey((record as StoredRecord).key),
              value: copyValue((record as StoredRecord).value),
            },
      );
      records.sort((left, right) => compareKeys(left.key, right.key));
      data.stores.set(storeName, { keyPath, records });
    }
    this.databases.set(name, data);
  }

  /** The values currently stored, in key order (empty when the store does not exist). */
  read(name: string, store: string): unknown[] {
    const records = this.databases.get(name)?.stores.get(store)?.records ?? [];
    return records.map((record) => copyValue(record.value));
  }

  /** Empties a store behind the code under test's back (e.g. site data cleared). */
  clear(name: string, store: string): void {
    const data = this.databases.get(name)?.stores.get(store);
    if (data) data.records = [];
  }

  storeNames(name: string): string[] {
    return [...(this.databases.get(name)?.stores.keys() ?? [])].sort();
  }

  private open(name: string, version?: number): FakeOpenRequest {
    const request = new FakeOpenRequest(null, null);
    setTimeout(() => {
      const existing = this.databases.get(name);
      const oldVersion = existing?.version ?? 0;
      const newVersion = version ?? Math.max(oldVersion, 1);
      if (newVersion < oldVersion) {
        request.error = new DOMException("The requested version is lower", "VersionError");
        request.readyState = "done";
        request.onerror?.(createEvent("error", request));
        return;
      }
      const data = existing ?? { version: 0, stores: new Map() };
      this.databases.set(name, data);
      const connection = new FakeDatabase(this, name, data);
      const succeed = () => {
        connection.upgradeTransaction = null;
        request.transaction = null;
        request.readyState = "done";
        this.connections.add(connection);
        request.onsuccess?.(createEvent("success", request));
      };
      request.result = connection;
      if (newVersion === oldVersion) {
        succeed();
        return;
      }

      for (const other of this.connections) {
        if (other.name === name) {
          other.onversionchange?.(createEvent("versionchange", other, { oldVersion, newVersion }));
        }
      }

      const previous = {
        version: data.version,
        stores: new Map(
          [...data.stores].map(([storeName, store]) => [
            storeName,
            { keyPath: store.keyPath, records: [...store.records] },
          ]),
        ),
      };
      const upgrade = new FakeTransaction(connection, null, "versionchange");
      upgrade.oncomplete = () => succeed();
      upgrade.onabort = () => {
        data.version = previous.version;
        data.stores = previous.stores;
        request.error = upgrade.error ?? new DOMException("The upgrade was aborted", "AbortError");
        request.readyState = "done";
        request.onerror?.(createEvent("error", request));
      };
      connection.upgradeTransaction = upgrade;
      request.transaction = upgrade;
      data.version = newVersion;
      request.onupgradeneeded?.(createEvent("upgradeneeded", request, { oldVersion, newVersion }));
    }, 0);
    return request;
  }
}
