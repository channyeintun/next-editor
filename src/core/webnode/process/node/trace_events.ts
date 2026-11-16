// The `trace_events` builtin. There is no V8 tracing agent in a browser, so a
// `Tracing` object can be created and toggled but never records anything:
// `enabled` stays false and `getEnabledCategories()` reports none.
import { makeNodeError, validateObject } from "./internalErrors";

/** What `createTracing` returns. */
export interface Tracing {
  enable(): void;
  disable(): void;
  readonly enabled: boolean;
  readonly categories: string;
}

/** `trace_events.createTracing({ categories })`. */
export function createTracing(options: { categories?: unknown }): Tracing {
  validateObject(options, "options");
  const { categories } = options;
  if (!Array.isArray(categories)) {
    throw makeNodeError(
      "ERR_INVALID_ARG_TYPE",
      `The "options.categories" property must be an instance of Array. Received ${typeof categories}`,
      TypeError,
    );
  }
  if (categories.length <= 0) {
    throw makeNodeError(
      "ERR_TRACE_EVENTS_CATEGORY_REQUIRED",
      "At least one category is required",
      TypeError,
    );
  }
  const joined = categories.map(String).join(",");
  return {
    enable() {},
    disable() {},
    enabled: false,
    categories: joined,
  };
}

/** `trace_events.getEnabledCategories()`: nothing is ever traced. */
export function getEnabledCategories(): string | undefined {
  return undefined;
}

const traceEvents = { createTracing, getEnabledCategories };

export default traceEvents;
