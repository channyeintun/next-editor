import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AUTH_FAILURE_WINDOW_MS,
  KEY_CHECK_PAUSE_FAILURES,
  readBreaker,
  recordAuthBlocked,
  recordAuthFailure,
  refundKeyCheck,
  reserveKeyCheck,
} from "./breaker";
import { openSqliteD1 } from "../../db/testing";

const T0 = 1_760_000_000_000;

function windowOf(sqlite: ReturnType<typeof openSqliteD1>["sqlite"]) {
  return sqlite.prepare("SELECT window_started_at, failures FROM provider_auth_breaker").get();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AthanLab auth breaker", () => {
  it("starts open", async () => {
    const { db } = openSqliteD1();

    expect(await readBreaker(db, T0)).toEqual({ keyChecksPaused: false, blockedUntil: 0 });
  });

  it("pauses key checks once a window holds enough failures", async () => {
    const { db } = openSqliteD1();

    for (let failure = 1; failure < KEY_CHECK_PAUSE_FAILURES; failure++) {
      await recordAuthFailure(db, T0 + failure);
    }
    expect((await readBreaker(db, T0 + 100)).keyChecksPaused).toBe(false);

    await recordAuthFailure(db, T0 + 200);
    expect(await readBreaker(db, T0 + 300)).toEqual({ keyChecksPaused: true, blockedUntil: 0 });
  });

  it("resumes when the fixed window ends, and a new failure starts a new window", async () => {
    const { db, sqlite } = openSqliteD1();
    for (let failure = 0; failure < KEY_CHECK_PAUSE_FAILURES; failure++) {
      await recordAuthFailure(db, T0 + failure);
    }

    expect((await readBreaker(db, T0 + AUTH_FAILURE_WINDOW_MS - 1)).keyChecksPaused).toBe(true);
    expect((await readBreaker(db, T0 + AUTH_FAILURE_WINDOW_MS)).keyChecksPaused).toBe(false);

    await recordAuthFailure(db, T0 + AUTH_FAILURE_WINDOW_MS + 5);
    expect(
      sqlite.prepare("SELECT window_started_at, failures FROM provider_auth_breaker").get(),
    ).toEqual({ window_started_at: T0 + AUTH_FAILURE_WINDOW_MS + 5, failures: 1 });
  });

  it("restarts a window stamped far in the future by a skewed clock", async () => {
    const { db, sqlite } = openSqliteD1();
    await recordAuthFailure(db, T0 + 60_001);

    await recordAuthFailure(db, T0);

    expect(windowOf(sqlite)).toEqual({ window_started_at: T0, failures: 1 });
  });

  it("keeps the window for a request whose clock is a little behind", async () => {
    // A Worker's clock moves only on I/O: a request can arrive stamped just
    // before the window a concurrent request opened. Restarting would wipe it.
    const { db, sqlite } = openSqliteD1();
    expect(await reserveKeyCheck(db, T0 + 5)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + 5,
    });

    expect(await reserveKeyCheck(db, T0)).toEqual({ kind: "reserved", windowStartedAt: T0 + 5 });
    await recordAuthFailure(db, T0 + 1);

    expect(windowOf(sqlite)).toEqual({ window_started_at: T0 + 5, failures: 3 });
    expect((await readBreaker(db, T0)).keyChecksPaused).toBe(false);
  });

  it("blocks every route for at least a minute, or for AthanLab's Retry-After", async () => {
    const { db } = openSqliteD1();

    expect(await recordAuthBlocked(db, null, T0)).toBe(T0 + 60_000);
    expect((await readBreaker(db, T0 + 59_999)).blockedUntil).toBe(T0 + 60_000);
    expect((await readBreaker(db, T0 + 60_000)).blockedUntil).toBe(0);

    await recordAuthBlocked(db, 600, T0);
    expect((await readBreaker(db, T0 + 1)).blockedUntil).toBe(T0 + 600_000);

    // A shorter block arriving later never cuts an existing one short.
    await recordAuthBlocked(db, 5, T0 + 1_000);
    expect((await readBreaker(db, T0 + 2_000)).blockedUntil).toBe(T0 + 600_000);
  });

  it("keeps the failure window when a block is recorded", async () => {
    const { db } = openSqliteD1();
    for (let failure = 0; failure < KEY_CHECK_PAUSE_FAILURES; failure++) {
      await recordAuthFailure(db, T0 + failure);
    }

    await recordAuthBlocked(db, 120, T0 + 100);

    expect(await readBreaker(db, T0 + 200)).toEqual({
      keyChecksPaused: true,
      blockedUntil: T0 + 100 + 120_000,
    });
  });

  it("never throws into the request path when D1 fails, and refuses reservations", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = openSqliteD1({ failWith: new Error("D1_ERROR: storage unavailable") });

    expect(await readBreaker(db, T0)).toEqual({ keyChecksPaused: false, blockedUntil: 0 });
    await expect(recordAuthFailure(db, T0)).resolves.toBeUndefined();
    expect(await recordAuthBlocked(db, 30, T0)).toBe(T0 + 60_000);
    await expect(refundKeyCheck(db, T0)).resolves.toBeUndefined();
    // The reservation is the gate: a failure to take one must not admit a check.
    expect(await reserveKeyCheck(db, T0)).toEqual({ kind: "unavailable" });
    expect(error).toHaveBeenCalledTimes(5);
  });
});

describe("key check reservations", () => {
  it("admit KEY_CHECK_PAUSE_FAILURES checks per window, counted before they run", async () => {
    const { db, sqlite } = openSqliteD1();

    for (let check = 0; check < KEY_CHECK_PAUSE_FAILURES; check++) {
      expect(await reserveKeyCheck(db, T0 + check)).toEqual({
        kind: "reserved",
        windowStartedAt: T0,
      });
    }
    expect(await reserveKeyCheck(db, T0 + 100)).toEqual({ kind: "paused" });
    expect(await reserveKeyCheck(db, T0 + AUTH_FAILURE_WINDOW_MS - 1)).toEqual({ kind: "paused" });
    expect(windowOf(sqlite)).toEqual({
      window_started_at: T0,
      failures: KEY_CHECK_PAUSE_FAILURES,
    });

    // A new window starts with this check counted.
    expect(await reserveKeyCheck(db, T0 + AUTH_FAILURE_WINDOW_MS)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + AUTH_FAILURE_WINDOW_MS,
    });
    expect(windowOf(sqlite)).toEqual({
      window_started_at: T0 + AUTH_FAILURE_WINDOW_MS,
      failures: 1,
    });
  });

  it("count stored-key failures against the same window", async () => {
    const { db } = openSqliteD1();
    for (let failure = 1; failure < KEY_CHECK_PAUSE_FAILURES; failure++) {
      await recordAuthFailure(db, T0 + failure);
    }

    expect((await reserveKeyCheck(db, T0 + 100)).kind).toBe("reserved");
    expect((await reserveKeyCheck(db, T0 + 101)).kind).toBe("paused");
  });

  it("give a slot back on refund, never below zero, and only in its own window", async () => {
    const { db, sqlite } = openSqliteD1();
    for (let check = 0; check < KEY_CHECK_PAUSE_FAILURES; check++) {
      await reserveKeyCheck(db, T0 + check);
    }

    await refundKeyCheck(db, T0);
    expect(await reserveKeyCheck(db, T0 + 50)).toEqual({ kind: "reserved", windowStartedAt: T0 });
    expect(await reserveKeyCheck(db, T0 + 51)).toEqual({ kind: "paused" });

    // A refund for a window that has since restarted touches nothing.
    await recordAuthFailure(db, T0 + AUTH_FAILURE_WINDOW_MS + 1);
    await refundKeyCheck(db, T0);
    expect(windowOf(sqlite)).toEqual({
      window_started_at: T0 + AUTH_FAILURE_WINDOW_MS + 1,
      failures: 1,
    });

    sqlite.prepare("UPDATE provider_auth_breaker SET failures = 0").run();
    await refundKeyCheck(db, T0 + AUTH_FAILURE_WINDOW_MS + 1);
    expect(windowOf(sqlite)).toMatchObject({ failures: 0 });
  });

  it("are refused while AthanLab blocks us, without counting", async () => {
    const { db, sqlite } = openSqliteD1();
    await recordAuthBlocked(db, 120, T0);

    expect(await reserveKeyCheck(db, T0 + 1_000)).toEqual({
      kind: "blocked",
      blockedUntil: T0 + 120_000,
    });
    expect(windowOf(sqlite)).toEqual({ window_started_at: T0, failures: 0 });

    expect((await reserveKeyCheck(db, T0 + 120_000)).kind).toBe("reserved");
  });
});
