// Node's wording for a value that cannot be cloned. The browser's
// DataCloneError says which call failed first ("Failed to execute
// 'postMessage' on 'MessagePort': () => {} could not be cloned."); Node's says
// only what could not be cloned ("() => {} could not be cloned."). Every clone
// webnode makes for a program (a port's or a channel's message,
// structuredClone) goes through `cloningAsNode`.

/** The browser's lead-in: the call and the interface that failed. */
const PLATFORM_LEAD_IN = /^Failed to execute '[^']*' on '[^']*': /;

const PlatformDOMException = DOMException;

/**
 * Runs `clone` (a call that clones a program's value) and answers what it
 * does; a DataCloneError it throws is thrown with Node's message.
 */
export function cloningAsNode<T>(clone: () => T): T {
  try {
    return clone();
  } catch (error) {
    if (
      error instanceof PlatformDOMException &&
      error.name === "DataCloneError" &&
      PLATFORM_LEAD_IN.test(error.message)
    ) {
      throw new PlatformDOMException(error.message.replace(PLATFORM_LEAD_IN, ""), "DataCloneError");
    }
    throw error;
  }
}
