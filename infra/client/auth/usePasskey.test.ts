import { describe, expect, it } from "vite-plus/test";
import { isPasskeyAlreadyRegistered, isPasskeyCancel } from "./usePasskey";

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
