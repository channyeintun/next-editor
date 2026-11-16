// The `cluster` builtin. A webnode process is always the primary and can
// never fork workers (there is no shared listening socket to hand out), so the
// module exists for its flags and EventEmitter surface; forking throws.
import EventEmitter from "./events";
import { makeNodeError } from "./internalErrors";

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `cluster.${name} is not available in webnode`,
  );
}

/** `cluster.Worker`: no worker can exist, so constructing one throws. */
export class Worker extends EventEmitter {
  constructor() {
    super();
    throw unavailable("Worker");
  }
}

/** `cluster.SCHED_NONE`. */
export const SCHED_NONE = 1;
/** `cluster.SCHED_RR`. */
export const SCHED_RR = 2;

/** `require("cluster")`: an EventEmitter carrying the primary's state. */
const cluster = Object.assign(new EventEmitter(), {
  isWorker: false,
  isMaster: true,
  isPrimary: true,
  Worker,
  workers: {} as Record<string, never>,
  settings: {} as Record<string, unknown>,
  SCHED_NONE,
  SCHED_RR,
  schedulingPolicy: SCHED_RR,
  setupPrimary(): never {
    throw unavailable("setupPrimary");
  },
  setupMaster(): never {
    throw unavailable("setupMaster");
  },
  fork(): never {
    throw unavailable("fork");
  },
  disconnect(): never {
    throw unavailable("disconnect");
  },
});

export default cluster;
