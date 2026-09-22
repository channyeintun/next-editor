import { fromCallback, type CallbackLogicFunction, type EventObject } from "xstate";

/**
 * `fromCallback` with `sendBack` typed as `TSentEvent`, the events the parent machine handles.
 * xstate's own third generic types `emit` and `.on()`, not `sendBack`, which it leaves accepting
 * any event object, so a misspelled event type or missing field would compile and be dropped
 * by the parent at runtime.
 */
export const fromTypedCallback = <
  TEvent extends EventObject,
  TInput,
  TSentEvent extends EventObject,
>(
  callback: CallbackLogicFunction<TEvent, TSentEvent, TInput>,
) => fromCallback<TEvent, TInput>(callback);
