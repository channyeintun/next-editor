import { fromCallback, type CallbackLogicFunction, type EventObject } from "xstate";

/**
 * `fromCallback` with `sendBack` typed as `TSentEvent`, the events the parent machine handles.
 * xstate's own third generic types `emit` and `.on()`, not `sendBack`, which it leaves accepting
 * any event object, so a misspelled event type or missing field would compile and be dropped
 * by the parent at runtime. `TEmitted` is that third generic: what the actor tells whoever
 * listens with `.on()`, which the parent machine never sees.
 */
export const fromTypedCallback = <
  TEvent extends EventObject,
  TInput,
  TSentEvent extends EventObject,
  TEmitted extends EventObject = EventObject,
>(
  callback: CallbackLogicFunction<TEvent, TSentEvent, TInput, TEmitted>,
) => fromCallback<TEvent, TInput, TEmitted>(callback);
