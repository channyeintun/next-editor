import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AUTH_FAILURE_WINDOW_MS,
  KEY_CHECK_PAUSE_FAILURES,
  KEY_CHECK_SLOTS_PER_USER,
  readBreaker,
  recordAuthBlocked,
  recordAuthFailure,
  refundKeyCheck,
  reserveKeyCheck,
} from "./breaker";
import { insertSignedInUser, openSqliteD1 } from "../../db/testing";

const T0 = 1_760_000_000_000;
const USER = "user-0";

/** A database holding enough users that every check in a window can be someone else's. */
function openWithUsers(options?: Parameters<typeof openSqliteD1>[0]) {
  const opened = openSqliteD1(options);
  for (let index = 0; index <= KEY_CHECK_PAUSE_FAILURES + 1; index++) {
    insertSignedInUser(opened.sqlite, `user-${index}`, `session-${index}`);
  }
  return opened;
}

function shareOf(sqlite: ReturnType<typeof openSqliteD1>["sqlite"], userId: string) {
  return sqlite
    .prepare("SELECT window_started_at, slots FROM provider_key_check_shares WHERE user_id = ?")
    .get(userId);
}

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
    const { db, sqlite } = openWithUsers();
    expect(await reserveKeyCheck(db, USER, T0 + 5)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + 5,
    });

    expect(await reserveKeyCheck(db, "user-1", T0)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + 5,
    });
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
    await expect(refundKeyCheck(db, USER, T0)).resolves.toBeUndefined();
    // The reservation is the gate: a failure to take one must not admit a check.
    expect(await reserveKeyCheck(db, USER, T0)).toEqual({ kind: "unavailable" });
    expect(error).toHaveBeenCalledTimes(5);
  });
});

describe("key check reservations", () => {
  it("admit KEY_CHECK_PAUSE_FAILURES checks per window, counted before they run", async () => {
    const { db, sqlite } = openWithUsers();

    for (let check = 0; check < KEY_CHECK_PAUSE_FAILURES; check++) {
      expect(await reserveKeyCheck(db, `user-${check}`, T0 + check)).toEqual({
        kind: "reserved",
        windowStartedAt: T0,
      });
    }
    const newcomer = `user-${KEY_CHECK_PAUSE_FAILURES}`;
    expect(await reserveKeyCheck(db, newcomer, T0 + 100)).toEqual({ kind: "paused" });
    expect(await reserveKeyCheck(db, newcomer, T0 + AUTH_FAILURE_WINDOW_MS - 1)).toEqual({
      kind: "paused",
    });
    // A refused check takes no share either.
    expect(shareOf(sqlite, newcomer)).toBeUndefined();
    expect(windowOf(sqlite)).toEqual({
      window_started_at: T0,
      failures: KEY_CHECK_PAUSE_FAILURES,
    });

    // A new window starts with this check counted.
    expect(await reserveKeyCheck(db, newcomer, T0 + AUTH_FAILURE_WINDOW_MS)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + AUTH_FAILURE_WINDOW_MS,
    });
    expect(windowOf(sqlite)).toEqual({
      window_started_at: T0 + AUTH_FAILURE_WINDOW_MS,
      failures: 1,
    });
  });

  it("count stored-key failures against the same window", async () => {
    const { db } = openWithUsers();
    for (let failure = 1; failure < KEY_CHECK_PAUSE_FAILURES; failure++) {
      await recordAuthFailure(db, T0 + failure);
    }

    expect((await reserveKeyCheck(db, USER, T0 + 100)).kind).toBe("reserved");
    expect((await reserveKeyCheck(db, "user-1", T0 + 101)).kind).toBe("paused");
  });

  it("give one user at most KEY_CHECK_SLOTS_PER_USER of a window's slots", async () => {
    const { db, sqlite } = openWithUsers();

    for (let check = 0; check < KEY_CHECK_SLOTS_PER_USER; check++) {
      expect((await reserveKeyCheck(db, USER, T0 + check)).kind).toBe("reserved");
    }
    expect(await reserveKeyCheck(db, USER, T0 + 10)).toEqual({ kind: "paused" });
    // Neither the window nor the share counted the refused check.
    expect(windowOf(sqlite)).toEqual({ window_started_at: T0, failures: KEY_CHECK_SLOTS_PER_USER });
    expect(shareOf(sqlite, USER)).toEqual({
      window_started_at: T0,
      slots: KEY_CHECK_SLOTS_PER_USER,
    });
    // Other users still have room…
    expect((await reserveKeyCheck(db, "user-1", T0 + 11)).kind).toBe("reserved");
    // …a refunded check gives its user a try back…
    await refundKeyCheck(db, USER, T0);
    expect((await reserveKeyCheck(db, USER, T0 + 12)).kind).toBe("reserved");
    expect((await reserveKeyCheck(db, USER, T0 + 13)).kind).toBe("paused");
    // …and the share starts over with the breaker's next window.
    expect(await reserveKeyCheck(db, USER, T0 + AUTH_FAILURE_WINDOW_MS)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + AUTH_FAILURE_WINDOW_MS,
    });
    expect(shareOf(sqlite, USER)).toEqual({
      window_started_at: T0 + AUTH_FAILURE_WINDOW_MS,
      slots: 1,
    });
  });

  it("align a user's share with a window a stored-key failure restarted", async () => {
    const { db, sqlite } = openWithUsers();
    await reserveKeyCheck(db, USER, T0);
    await reserveKeyCheck(db, USER, T0 + 1);

    await recordAuthFailure(db, T0 + AUTH_FAILURE_WINDOW_MS + 7);

    expect(await reserveKeyCheck(db, USER, T0 + AUTH_FAILURE_WINDOW_MS + 8)).toEqual({
      kind: "reserved",
      windowStartedAt: T0 + AUTH_FAILURE_WINDOW_MS + 7,
    });
    expect(shareOf(sqlite, USER)).toEqual({
      window_started_at: T0 + AUTH_FAILURE_WINDOW_MS + 7,
      slots: 1,
    });
  });

  it("give a slot back on refund, never below zero, and only in its own window", async () => {
    const { db, sqlite } = openWithUsers();
    for (let check = 0; check < KEY_CHECK_PAUSE_FAILURES; check++) {
      await reserveKeyCheck(db, `user-${check}`, T0 + check);
    }

    await refundKeyCheck(db, USER, T0);
    expect(await reserveKeyCheck(db, USER, T0 + 50)).toEqual({
      kind: "reserved",
      windowStartedAt: T0,
    });
    expect(await reserveKeyCheck(db, "user-1", T0 + 51)).toEqual({ kind: "paused" });

    // A refund for a window that has since restarted touches nothing.
    await recordAuthFailure(db, T0 + AUTH_FAILURE_WINDOW_MS + 1);
    await refundKeyCheck(db, USER, T0);
    expect(windowOf(sqlite)).toEqual({
      window_started_at: T0 + AUTH_FAILURE_WINDOW_MS + 1,
      failures: 1,
    });

    sqlite.prepare("UPDATE provider_auth_breaker SET failures = 0").run();
    await refundKeyCheck(db, USER, T0 + AUTH_FAILURE_WINDOW_MS + 1);
    expect(windowOf(sqlite)).toMatchObject({ failures: 0 });
  });

  it("are refused while AthanLab blocks us, without counting", async () => {
    const { db, sqlite } = openWithUsers();
    await recordAuthBlocked(db, 120, T0);

    expect(await reserveKeyCheck(db, USER, T0 + 1_000)).toEqual({
      kind: "blocked",
      blockedUntil: T0 + 120_000,
    });
    expect(windowOf(sqlite)).toEqual({ window_started_at: T0, failures: 0 });
    expect(shareOf(sqlite, USER)).toBeUndefined();

    expect((await reserveKeyCheck(db, USER, T0 + 120_000)).kind).toBe("reserved");
  });
});
