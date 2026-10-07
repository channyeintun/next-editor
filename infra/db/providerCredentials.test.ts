// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  acquireCredentialProbe,
  deleteProviderCredential,
  getProviderCredential,
  invalidateProviderCredential,
  putProviderCredential,
  releaseCredentialProbe,
  type PutProviderCredentialParams,
} from "./providerCredentials";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/**
 * A database at the production schema: every migration applied in the order
 * wrangler applies them, with foreign keys enforced as D1 enforces them, and
 * one user to own credentials.
 */
function openDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    sqlite.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  }
  sqlite
    .prepare(
      "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .run("user-1", "google-1", "user@example.com", "user");

  function statement(sql: string, args: unknown[] = []) {
    return {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
      // As D1 reports it: rows this statement wrote (node:sqlite alone repeats
      // the previous write's count after a read).
      run: async () => {
        const before = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
        const result = sqlite.prepare(sql).run(...(args as never[]));
        const after = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
        return { meta: { changes: before === after ? 0 : Number(result.changes) } };
      },
    };
  }

  return { db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database, sqlite };
}

/** The nonce `sealed()` stores by default: names the sealed key a lease is for. */
const IV = "aXYtMDAwMDAwMDE=";

function sealed(overrides: Partial<PutProviderCredentialParams> = {}): PutProviderCredentialParams {
  return {
    userId: "user-1",
    provider: "athanlab",
    ciphertext: "Y2lwaGVydGV4dA==",
    iv: "aXYtMDAwMDAwMDE=",
    keyVersion: 1,
    keyHint: "ab12",
    now: 1_000,
    ...overrides,
  };
}

describe("provider credentials", () => {
  it("reads nothing before a key is stored", async () => {
    const { db } = openDb();

    expect(await getProviderCredential(db, "user-1", "athanlab")).toBeNull();
  });

  it("stores a sealed key and reads it back", async () => {
    const { db } = openDb();

    await putProviderCredential(db, sealed());

    expect(await getProviderCredential(db, "user-1", "athanlab")).toEqual({
      user_id: "user-1",
      provider: "athanlab",
      ciphertext: "Y2lwaGVydGV4dA==",
      iv: "aXYtMDAwMDAwMDE=",
      key_version: 1,
      key_hint: "ab12",
      invalidated_at: null,
      probe_token: null,
      probe_until: null,
      created_at: 1_000,
      updated_at: 1_000,
    });
  });

  it("replaces a key in place, keeping created_at and clearing invalidated_at", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed());
    await invalidateProviderCredential(db, "user-1", "athanlab", 1_500);

    await putProviderCredential(
      db,
      sealed({ ciphertext: "bmV3", iv: "aXYtMDAwMDAwMDI=", keyHint: "cd34", now: 2_000 }),
    );

    expect(await getProviderCredential(db, "user-1", "athanlab")).toMatchObject({
      ciphertext: "bmV3",
      iv: "aXYtMDAwMDAwMDI=",
      key_hint: "cd34",
      invalidated_at: null,
      created_at: 1_000,
      updated_at: 2_000,
    });
  });

  it("invalidates a key once and keeps the first rejection time", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed());

    await invalidateProviderCredential(db, "user-1", "athanlab", 1_500);
    await invalidateProviderCredential(db, "user-1", "athanlab", 1_900);

    expect((await getProviderCredential(db, "user-1", "athanlab"))?.invalidated_at).toBe(1_500);
  });

  it("leaves a replacement key alone when the rejected key was the one it replaced", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed({ iv: "b2xkLWl2" }));
    // The user connects a new key while a request with the old one is in flight.
    await putProviderCredential(db, sealed({ iv: "bmV3LWl2", now: 2_000 }));

    await invalidateProviderCredential(db, "user-1", "athanlab", 2_500, "b2xkLWl2");
    expect((await getProviderCredential(db, "user-1", "athanlab"))?.invalidated_at).toBeNull();

    await invalidateProviderCredential(db, "user-1", "athanlab", 2_600, "bmV3LWl2");
    expect((await getProviderCredential(db, "user-1", "athanlab"))?.invalidated_at).toBe(2_600);
  });

  it("grants the first-contact lease to one holder at a time", async () => {
    const { db } = openDb();
    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "a", 1_000, 15_000)).toBe(
      false,
    );
    await putProviderCredential(db, sealed());

    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "a", 1_000, 15_000)).toBe(
      true,
    );
    expect(await getProviderCredential(db, "user-1", "athanlab")).toMatchObject({
      probe_token: "a",
      probe_until: 16_000,
    });
    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "b", 2_000, 15_000)).toBe(
      false,
    );
    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "b", 16_000, 15_000)).toBe(
      false,
    );

    // Only the holder's token releases it.
    await releaseCredentialProbe(db, "user-1", "athanlab", "b");
    expect((await getProviderCredential(db, "user-1", "athanlab"))?.probe_token).toBe("a");
    await releaseCredentialProbe(db, "user-1", "athanlab", "a");
    expect(await getProviderCredential(db, "user-1", "athanlab")).toMatchObject({
      probe_token: null,
      probe_until: null,
    });
    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "b", 3_000, 15_000)).toBe(
      true,
    );
  });

  it("lets a lapsed lease be taken over, and its old holder release nothing", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed());
    await acquireCredentialProbe(db, "user-1", "athanlab", IV, "stalled", 1_000, 15_000);

    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "b", 16_001, 15_000)).toBe(
      true,
    );
    await releaseCredentialProbe(db, "user-1", "athanlab", "stalled");

    expect((await getProviderCredential(db, "user-1", "athanlab"))?.probe_token).toBe("b");
  });

  it("never grants the lease on an invalidated key, and clears it on replacement", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed());
    await acquireCredentialProbe(db, "user-1", "athanlab", IV, "a", 1_000, 15_000);
    await invalidateProviderCredential(db, "user-1", "athanlab", 1_500);

    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "b", 20_000, 15_000)).toBe(
      false,
    );

    await putProviderCredential(db, sealed({ iv: "bmV3LWl2", now: 2_000 }));
    expect(await getProviderCredential(db, "user-1", "athanlab")).toMatchObject({
      invalidated_at: null,
      probe_token: null,
      probe_until: null,
    });
    expect(
      await acquireCredentialProbe(db, "user-1", "athanlab", "bmV3LWl2", "b", 2_000, 15_000),
    ).toBe(true);
  });

  it("never grants the lease to a request carrying a key that has since been replaced", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed());
    // The user connects a new key while a request that decrypted the old one waits.
    await putProviderCredential(db, sealed({ iv: "bmV3LWl2", now: 2_000 }));

    expect(await acquireCredentialProbe(db, "user-1", "athanlab", IV, "old", 3_000, 15_000)).toBe(
      false,
    );
    expect(
      await acquireCredentialProbe(db, "user-1", "athanlab", "bmV3LWl2", "new", 3_000, 15_000),
    ).toBe(true);
  });

  it("deletes a key, idempotently", async () => {
    const { db } = openDb();
    await putProviderCredential(db, sealed());

    await deleteProviderCredential(db, "user-1", "athanlab");
    await deleteProviderCredential(db, "user-1", "athanlab");

    expect(await getProviderCredential(db, "user-1", "athanlab")).toBeNull();
  });

  it("goes away with its user", async () => {
    const { db, sqlite } = openDb();
    await putProviderCredential(db, sealed());

    sqlite.prepare("DELETE FROM users WHERE id = ?").run("user-1");

    expect(await getProviderCredential(db, "user-1", "athanlab")).toBeNull();
  });

  it("refuses providers the schema does not know and users that do not exist", async () => {
    const { db } = openDb();

    await expect(putProviderCredential(db, sealed({ provider: "other" as never }))).rejects.toThrow(
      /CHECK constraint/,
    );
    await expect(putProviderCredential(db, sealed({ userId: "nobody" }))).rejects.toThrow(
      /FOREIGN KEY constraint/,
    );
  });

  it("creates the auth breaker table with one row per provider", () => {
    const { sqlite } = openDb();
    sqlite
      .prepare(
        "INSERT INTO provider_auth_breaker (provider, window_started_at, failures) VALUES (?, ?, ?)",
      )
      .run("athanlab", 1_000, 1);

    expect(sqlite.prepare("SELECT * FROM provider_auth_breaker").all()).toEqual([
      { provider: "athanlab", window_started_at: 1_000, failures: 1, blocked_until: 0 },
    ]);
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO provider_auth_breaker (provider, window_started_at, failures) VALUES (?, ?, ?)",
        )
        .run("athanlab", 2_000, 1),
    ).toThrow(/UNIQUE constraint/);
  });
});
