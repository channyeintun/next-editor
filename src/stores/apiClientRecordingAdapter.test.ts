import { describe, expect, it } from "vite-plus/test";
import { recordedApiStateToReplayPayload, toRecordedApiRequest } from "./apiClientRecordingAdapter";

describe("recordedApiStateToReplayPayload", () => {
  it("shows a recorded request, its result and its history", () => {
    const payload = recordedApiStateToReplayPayload({
      request: { method: "POST", path: "/todos", headers: { "x-id": "7" }, body: "{}" },
      result: {
        ok: true,
        status: 201,
        statusText: "Created",
        headers: [],
        body: "ok",
        durationMs: 12,
      },
      sending: true,
      history: [
        {
          id: "h1",
          request: { method: "GET", path: "/todos", headers: {}, body: "" },
          result: { ok: false, error: "offline", durationMs: 3 },
        },
      ],
    });

    expect(payload).toEqual({
      method: "POST",
      path: "/todos",
      body: "{}",
      headers: [{ key: "x-id", value: "7", enabled: true }],
      sending: true,
      result: {
        ok: true,
        response: {
          status: 201,
          statusText: "Created",
          headers: [],
          body: "ok",
          durationMs: 12,
          truncated: undefined,
          bodyBytes: undefined,
        },
      },
      history: [
        {
          id: "h1",
          method: "GET",
          path: "/todos",
          headers: [],
          body: "",
          result: { ok: false, error: { error: "offline", durationMs: 3 } },
          timestamp: 0,
        },
      ],
    });
  });

  it("falls back to an idle GET / for a state recorded before any request", () => {
    expect(recordedApiStateToReplayPayload({})).toEqual({
      method: "GET",
      path: "/",
      body: "",
      headers: [],
      sending: false,
      result: null,
      history: [],
    });
  });
});

describe("toRecordedApiRequest", () => {
  it("sends and records only the enabled, named headers, keyed by their trimmed name", () => {
    const recorded = toRecordedApiRequest({
      method: "POST",
      path: "/todos",
      headers: [
        { key: " x-id ", value: "7", enabled: true },
        { key: "x-off", value: "1", enabled: false },
        { key: "  ", value: "blank", enabled: true },
      ],
      body: "{}",
    });

    expect(recorded).toEqual({
      method: "POST",
      path: "/todos",
      headers: { "x-id": "7" },
      body: "{}",
    });
  });

  it("sends no body with a GET, nor an empty one with any method", () => {
    const request = { path: "/todos", headers: [], body: "ignored" };
    expect(toRecordedApiRequest({ ...request, method: "GET" }).body).toBeUndefined();
    expect(toRecordedApiRequest({ ...request, method: "DELETE", body: "" }).body).toBeUndefined();
    expect(toRecordedApiRequest({ ...request, method: "PUT" }).body).toBe("ignored");
  });
});
