import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vite-plus/test";
import { isPasskeyAlreadyRegistered, isPasskeyCancel, isPasskeySignInTooOld } from "./usePasskey";

// What @simplewebauthn/browser's WebAuthnError looks like to a caller: an
// Error whose `code` names the case and whose `name` comes from its cause.
function webAuthnError(code: string, name: string): Error {
  return Object.assign(new Error("ceremony failed"), { code, name });
}

// A browser's DOMException is an Error; jsdom's is not, so stand one in.
function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe("isPasskeyAlreadyRegistered", () => {
  it("recognizes the library's duplicate-passkey code without its class", () => {
    expect(isPasskeyAlreadyRegistered({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toBe(
      true,
    );
    expect(
      isPasskeyAlreadyRegistered(
        webAuthnError("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "InvalidStateError"),
      ),
    ).toBe(true);
  });

  it("recognizes the browser's own InvalidStateError", () => {
    expect(isPasskeyAlreadyRegistered(domError("InvalidStateError"))).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isPasskeyAlreadyRegistered(webAuthnError("ERROR_CEREMONY_ABORTED", "AbortError"))).toBe(
      false,
    );
    expect(isPasskeyAlreadyRegistered(new Error("network"))).toBe(false);
    expect(isPasskeyAlreadyRegistered(null)).toBe(false);
    expect(isPasskeyAlreadyRegistered("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")).toBe(false);
  });
});

describe("isPasskeyCancel", () => {
  it("treats a dismissed passkey dialog as a cancel", () => {
    expect(isPasskeyCancel(domError("NotAllowedError"))).toBe(true);
    expect(isPasskeyCancel(domError("InvalidStateError"))).toBe(false);
  });
});

function httpError(status: number, data: unknown): AxiosError {
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status,
    statusText: "",
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

describe("isPasskeySignInTooOld", () => {
  // Adding a passkey needs a recent sign-in, and the server says so with a
  // flagged 403 rather than a ceremony failure.
  it("recognizes the server asking for a fresh sign-in", () => {
    expect(isPasskeySignInTooOld(httpError(403, { error: "x", reauthenticate: true }))).toBe(true);
  });

  it("leaves other refusals alone", () => {
    expect(isPasskeySignInTooOld(httpError(403, { error: "x" }))).toBe(false);
    expect(isPasskeySignInTooOld(httpError(401, { reauthenticate: true }))).toBe(false);
    expect(isPasskeySignInTooOld(domError("NotAllowedError"))).toBe(false);
  });
});
