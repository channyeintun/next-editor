// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { sh } from "../testHelpers";
import { formatDate } from "./date";

afterEach(() => {
  setRuntime(null);
});

// Expected values are GNU date's (gdate) for the same arguments.
describe("date", () => {
  it("--iso-8601=TIMESPEC and -ITIMESPEC", async () => {
    const out = (
      await sh(
        "date -u -d @0 --iso-8601=seconds; date -u -d @0 -Iseconds; date -u -d @0 -Iminutes; date -u -d @0 --iso-8601=hours; date -u -d @0 -I; date -u -d @0 --iso-8601; date -u -d @0.5 -Ins",
      )
    ).out;
    expect(out).toBe(
      "1970-01-01T00:00:00+00:00\n1970-01-01T00:00:00+00:00\n1970-01-01T00:00+00:00\n1970-01-01T00+00:00\n1970-01-01\n1970-01-01\n1970-01-01T00:00:00,500000000+00:00\n",
    );
    const bad = await sh("date --iso-8601=foo");
    expect(bad.err).toBe("date: invalid argument 'foo' for '--iso-8601'\n");
    expect(bad.status).toBe(1);
  });

  it("widths on conversions: %3N, %5Y, %3d", async () => {
    expect((await sh("date -u -d @0.5 '+%s%3N|%N|%6N|%10N'")).out).toBe(
      "0500|500000000|500000|5000000000\n",
    );
    expect((await sh("date -u -d @0 '+%5Y|%3d|%-d'")).out).toBe("01970|001|1\n");
  });

  it("%:z, %::z and %:::z", () => {
    const at = new Date(0);
    expect(formatDate(at, "%z %:z %::z %:::z", true)).toBe("+0000 +00:00 +00:00:00 +00");
  });
});
