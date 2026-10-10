import { describe, expect, it } from "vite-plus/test";
import { recordedApiStateToReplayPayload } from "./apiClientRecordingAdapter";

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
