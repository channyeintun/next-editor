import { describe, expect, it } from "vite-plus/test";
import { messageFromError, requestErrorStatus } from "./errorMessage";

/** What axios rejects with for a failed request: its own status line, the body on `response`. */
function axiosError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

describe("requestErrorStatus", () => {
  it("returns the status of a failed request", () => {
    expect(requestErrorStatus(axiosError(404, { error: "not found" }))).toBe(404);
  });

  it("returns null for anything without a numeric response status", () => {
    expect(requestErrorStatus(new Error("offline"))).toBeNull();
    expect(requestErrorStatus({ response: { status: "404" } })).toBeNull();
    expect(requestErrorStatus(null)).toBeNull();
    expect(requestErrorStatus("404")).toBeNull();
  });
});

describe("messageFromError", () => {
  it("prefers the server's reason to the request's status line", () => {
    expect(messageFromError(axiosError(409, { error: "room is not active" }), "fallback")).toBe(
      "room is not active",
    );
  });

  it("uses the error's own message when the body gives no reason", () => {
    expect(messageFromError(axiosError(503, "Service Unavailable"), "fallback")).toBe(
      "Request failed with status code 503",
    );
    expect(messageFromError(new Error("socket closed"), "fallback")).toBe("socket closed");
  });

  it("falls back when there is no message at all", () => {
    expect(messageFromError(new Error(""), "fallback")).toBe("fallback");
    expect(messageFromError({ response: { status: 503 } }, "fallback")).toBe("fallback");
    expect(messageFromError(undefined, "fallback")).toBe("fallback");
  });
});
