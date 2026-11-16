// The deprecated `domain` builtin, minimal: a `Domain` EventEmitter whose
// `run`, `bind` and `intercept` route errors thrown synchronously by the
// wrapped code to its `error` event, plus the enter/exit stack. Node also
// catches errors that escape to the event loop (through `uncaughtException`)
// and those emitted by member emitters; webnode only does the synchronous
// part, and does not set `process.domain` (the `process` object is the
// host's).
import EventEmitter from "./events";

type AnyFunction = (...args: unknown[]) => unknown;

/** Domains entered and not yet exited, innermost last (`domain._stack`). */
export const _stack: Domain[] = [];

let active: Domain | null = null;

interface DomainError {
  domain?: Domain;
  domainThrown?: boolean;
  domainBound?: AnyFunction;
  domainEmitter?: unknown;
}

function decorate(error: unknown, fields: DomainError): void {
  if (error !== null && typeof error === "object") {
    Object.assign(error, fields);
  }
}

/** `domain.Domain`. */
export class Domain extends EventEmitter {
  /** Emitters and timers explicitly added with `add`. */
  members: unknown[] = [];

  /** Makes this the active domain. */
  enter(): void {
    _stack.push(this);
    active = _stack[_stack.length - 1];
  }

  /** Leaves this domain and any entered after it. */
  exit(): void {
    const index = _stack.lastIndexOf(this);
    if (index === -1) {
      return;
    }
    _stack.splice(index);
    active = _stack[_stack.length - 1] ?? null;
  }

  /** Adds an emitter (or timer) to the domain; it leaves the domain it was in. */
  add(member: unknown): void {
    const target = member as { domain?: Domain | null };
    if (target.domain === this) {
      return;
    }
    if (target.domain instanceof Domain) {
      target.domain.remove(member);
    }
    target.domain = this;
    this.members.push(member);
  }

  /** Removes `member` from the domain. */
  remove(member: unknown): void {
    (member as { domain?: Domain | null }).domain = null;
    const index = this.members.indexOf(member);
    if (index !== -1) {
      this.members.splice(index, 1);
    }
  }

  /** Runs `fn` inside the domain; a synchronous throw is emitted as `error`. */
  run<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R | undefined {
    this.enter();
    try {
      return fn.apply(this, args);
    } catch (error) {
      decorate(error, { domain: this, domainThrown: true });
      this.emit("error", error);
      return undefined;
    } finally {
      this.exit();
    }
  }

  /** Wraps `callback` so it runs inside the domain. */
  bind<F extends AnyFunction>(callback: F): F {
    const runInDomain = (thisArg: unknown, args: unknown[]) =>
      this.run(() => callback.apply(thisArg, args));
    function runBound(this: unknown, ...args: unknown[]): unknown {
      return runInDomain(this, args);
    }
    Object.defineProperty(runBound, "domain", { value: this, configurable: true, writable: true });
    return runBound as F;
  }

  /** Like `bind`, but a first-argument error is emitted as `error` instead of reaching `callback`. */
  intercept<F extends AnyFunction>(callback: F): (error: unknown, ...args: unknown[]) => unknown {
    const onError = (error: unknown) => {
      decorate(error, { domainBound: callback, domainThrown: false, domain: this });
      this.emit("error", error);
    };
    const runInDomain = (thisArg: unknown, args: unknown[]) =>
      this.run(() => callback.apply(thisArg, args));
    function runIntercepted(this: unknown, error: unknown, ...args: unknown[]): unknown {
      if (error) {
        onError(error);
        return undefined;
      }
      return runInDomain(this, args);
    }
    Object.defineProperty(runIntercepted, "domain", {
      value: this,
      configurable: true,
      writable: true,
    });
    return runIntercepted;
  }

  /** Deprecated in Node and a no-op since v9 beyond exiting. */
  dispose(): void {
    this.exit();
  }
}

/** `domain.create()`. */
export function create(): Domain {
  return new Domain();
}

/** `domain.createDomain()`, the same as `create`. */
export const createDomain = create;

/** `require("domain")`; `active` reads the innermost entered domain. */
const domain = {
  _stack,
  Domain,
  createDomain,
  create,
  get active(): Domain | null {
    return active;
  },
};

export default domain;
