// @vitest-environment node
// Node's wording for a DataCloneError the platform raised with its own.
import { describe, expect, it } from "vitest";
import { cloningAsNode } from "./dataCloneError";

const thrownBy = (clone: () => unknown): unknown => {
  try {
    clone();
  } catch (error) {
    return error;
  }
  return null;
};

describe("cloningAsNode", () => {
  it("drops the browser's lead-in from a DataCloneError, as Node words it", () => {
    const error = thrownBy(() =>
      cloningAsNode(() => {
        throw new DOMException(
          "Failed to execute 'postMessage' on 'MessagePort': () => {} could not be cloned.",
          "DataCloneError",
        );
      }),
    );
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "DataCloneError",
      code: 25,
      message: "() => {} could not be cloned.",
    });
  });

  it("answers what the clone answers and leaves other errors as they are", () => {
    expect(cloningAsNode(() => 7)).toBe(7);
    const own = new DOMException(
      "MessagePort in transfer list is already detached",
      "DataCloneError",
    );
    expect(
      thrownBy(() =>
        cloningAsNode(() => {
          throw own;
        }),
      ),
    ).toBe(own);
    const other = new TypeError(
      "Failed to execute 'postMessage' on 'MessagePort': 1 argument required",
    );
    expect(
      thrownBy(() =>
        cloningAsNode(() => {
          throw other;
        }),
      ),
    ).toBe(other);
  });

  it("keeps Node's own message", () => {
    const error = thrownBy(() => cloningAsNode(() => structuredClone(() => {})));
    expect(error).toMatchObject({
      name: "DataCloneError",
      message: "() => {} could not be cloned.",
    });
  });
});
