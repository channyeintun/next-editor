import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RoomSqliteStorage } from "../collaboration/roomSqliteDocumentStore";

/**
 * The slice of a SQLite-backed Durable Object's storage that the room uses,
 * backed by an in-memory node:sqlite database. Call close() after each test.
 */
export class SqliteTestStorage implements RoomSqliteStorage {
  readonly database = new DatabaseSync(":memory:");
  readonly sql = {
    exec: <Row = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): Row[] } => {
      // Schema setup is one multi-statement string, which prepare() rejects.
      if (bindings.length === 0 && query.trimStart().startsWith("CREATE TABLE")) {
        this.database.exec(query);
        return { toArray: () => [] };
      }
      const statement = this.database.prepare(query);
      if (statement.columns().length === 0) {
        statement.run(...(bindings as SQLInputValue[]));
        return { toArray: () => [] };
      }
      const rows = statement.all(...(bindings as SQLInputValue[])) as Row[];
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
