import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { RoomSqliteStorage } from "../collaboration/roomSqliteDocumentStore";

/**
 * SQLite-backed Durable Objects refuse any string or BLOB over 2 MB
 * ("Maximum string, BLOB or table row size", Durable Objects limits).
 */
const DURABLE_OBJECT_SQLITE_MAX_VALUE_BYTES = 2_000_000;

function valueByteLength(value: unknown): number {
  if (typeof value === "string") {
    // UTF-8 needs at most three bytes per UTF-16 unit; encode only near the limit.
    if (value.length * 3 <= DURABLE_OBJECT_SQLITE_MAX_VALUE_BYTES) return value.length;
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

/** Durable Object SQL binds BLOBs as ArrayBuffer; node:sqlite would store one as NULL. */
function toNodeBinding(value: unknown): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

/** Durable Object SQL returns BLOBs as ArrayBuffer; node:sqlite returns Uint8Array. */
function toDurableObjectRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    converted[column] =
      value instanceof Uint8Array
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value;
  }
  return converted;
}

/**
 * The slice of a SQLite-backed Durable Object's storage that the room uses,
 * backed by an in-memory node:sqlite database with the Durable Object's value
 * types and value size limit. Call close() after each test.
 */
export class SqliteTestStorage implements RoomSqliteStorage {
  readonly database = new DatabaseSync(":memory:");
  readonly sql = {
    exec: <Row = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): Row[] } => {
      for (const value of bindings) {
        if (valueByteLength(value) > DURABLE_OBJECT_SQLITE_MAX_VALUE_BYTES) {
          throw new Error("SQLITE_TOOBIG: string or blob too big");
        }
      }
      // Schema setup is one multi-statement string, which prepare() rejects.
      if (bindings.length === 0 && query.trimStart().startsWith("CREATE TABLE")) {
        this.database.exec(query);
        return { toArray: () => [] };
      }
      const statement = this.database.prepare(query);
      const nodeBindings = bindings.map(toNodeBinding);
      if (statement.columns().length === 0) {
        statement.run(...nodeBindings);
        return { toArray: () => [] };
      }
      const rows = statement.all(...nodeBindings).map(toDurableObjectRow) as Row[];
      return { toArray: () => rows };
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
