// Making the shared filesystem: the memory, the compiled module, its initial
// data and the first instance. Only the kernel runs this, and this is the one
// file that carries the module's bytes. A process joins with what it is handed
// (`module`, `memory`, an admitted slot) and builds its own `SharedFs`.
import { OFFSET, PROCESS_SLOTS, SLOT_RETIRING } from "./abi";
import { SharedFs } from "./sharedFs";
import { SHARED_FS_DATA_SEGMENTS, SHARED_FS_MEMORY, SHARED_FS_WASM_BASE64 } from "./wasm.generated";

/** Maximum sizes tried, in 64 KiB pages: 4 GiB, then less where an engine refuses to reserve it. */
const MAXIMUM_PAGES = [65536, 32768, 16384, 8192];

export interface SharedFilesystemOptions {
  /** The kernel's clock for timestamps, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The most memory the filesystem may grow to, in 64 KiB pages. Defaults to
   * the whole 4 GiB; a test of what happens when space runs out gives less.
   */
  maximumPages?: number;
  /** How long `retire` waits for a worker to leave a call, in milliseconds. */
  retireTimeoutMs?: number;
}

/**
 * How a worker was retired: it was `outside` a call; it was `inside` one and
 * left it; or it never left and was `abandoned`, with the filesystem.
 */
export type RetireOutcome = "outside" | "inside" | "abandoned";

/**
 * Longer than any call takes: a call is a few microseconds, and the longest
 * (copying a file of gigabytes) well under a second.
 */
const RETIRE_TIMEOUT_MS = 10_000;

/** The shared filesystem, as the kernel holds it. */
export interface SharedFilesystem {
  /** The kernel's instance; it delivers the watch events. */
  readonly fs: SharedFs;
  /** What a process needs to build its own instance. */
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  /** Gives a new process a free slot holding a fresh token, or null when all are taken. */
  admit(): { slot: number; token: number } | null;
  /**
   * Shuts a process out and terminates it safely (README.md, Rules): clears
   * its slot, waiting first for the end of a call it is inside, so that it
   * holds no lock and never takes one again, then terminates it. Blocks for at
   * most that one call.
   *
   * A worker that does not leave its call in time is not coming back. Waiting
   * on would stop the kernel, and the whole runtime with it, so the filesystem
   * is given up instead: poisoned, and its lock freed, so that every call
   * fails at once rather than waits for a lock a dead worker holds.
   */
  retire(slot: number, terminate: () => void): RetireOutcome;
}

let compiled: WebAssembly.Module | null = null;

function compileModule(): WebAssembly.Module {
  if (compiled === null) {
    compiled = new WebAssembly.Module(decodeBase64(SHARED_FS_WASM_BASE64));
  }
  return compiled;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createMemory(limit: number): WebAssembly.Memory | null {
  const sizes = MAXIMUM_PAGES.filter((pages) => pages <= limit);
  for (const maximum of sizes.length > 0 ? sizes : [limit]) {
    try {
      return new WebAssembly.Memory({ initial: SHARED_FS_MEMORY.initial, maximum, shared: true });
    } catch {
      // Too large to reserve here: try the next size.
    }
  }
  return null;
}

/**
 * Makes the shared filesystem, or returns null where this engine cannot (no
 * WebAssembly, no shared memory, or no size of it accepted). The caller then
 * keeps the TypeScript filesystem.
 */
export function createSharedFilesystem(
  options: SharedFilesystemOptions = {},
): SharedFilesystem | null {
  if (typeof WebAssembly !== "object" || typeof SharedArrayBuffer !== "function") {
    return null;
  }
  let module: WebAssembly.Module;
  try {
    module = compileModule();
  } catch {
    return null;
  }
  const memory = createMemory(options.maximumPages ?? MAXIMUM_PAGES[0]);
  if (memory === null) {
    return null;
  }
  const bytes = new Uint8Array(memory.buffer);
  for (const [address, data] of SHARED_FS_DATA_SEGMENTS) {
    bytes.set(decodeBase64(data), address);
  }
  const fs = new SharedFs({ module, memory, now: options.now ?? Date.now, deliversEvents: true });
  fs.init();

  const base = fs.base;
  const words = new Int32Array(memory.buffer);
  const firstSlot = (base + OFFSET.slots) / 4;
  const lockIndex = (base + OFFSET.lock) / 4;
  const poisonedIndex = (base + OFFSET.poisoned) / 4;
  const retireTimeoutMs = options.retireTimeoutMs ?? RETIRE_TIMEOUT_MS;
  let nextToken = 1;
  let nextSlot = 0;

  return {
    fs,
    module,
    memory,
    admit() {
      for (let tried = 0; tried < PROCESS_SLOTS; tried++) {
        const slot = (nextSlot + tried) % PROCESS_SLOTS;
        if (Atomics.load(words, firstSlot + slot) === 0) {
          const token = nextToken;
          // Tokens are never 0 (a free slot) and never repeat soon, so a
          // retired worker never matches the slot's next owner.
          nextToken = nextToken === 0x7fffffff ? 1 : nextToken + 1;
          nextSlot = (slot + 1) % PROCESS_SLOTS;
          Atomics.store(words, firstSlot + slot, token);
          return { slot, token };
        }
      }
      return null;
    },
    retire(slot, terminate) {
      const index = firstSlot + slot;
      const deadline = Date.now() + retireTimeoutMs;
      let outcome: RetireOutcome = "outside";
      for (;;) {
        const state = Atomics.load(words, index);
        if (state === 0) {
          break;
        }
        if (state === SLOT_RETIRING) {
          // Inside a call: it clears the slot once it has let go of the lock.
          outcome = "inside";
          const remaining = deadline - Date.now();
          if (
            remaining <= 0 ||
            Atomics.wait(words, index, SLOT_RETIRING, remaining) === "timed-out"
          ) {
            outcome = "abandoned";
            Atomics.store(words, poisonedIndex, 1);
            Atomics.store(words, index, 0);
            Atomics.store(words, lockIndex, 0);
            Atomics.notify(words, lockIndex);
            break;
          }
        } else if (state > 0) {
          // Outside a call: with the slot cleared it never enters again.
          if (Atomics.compareExchange(words, index, state, 0) === state) {
            break;
          }
        } else {
          Atomics.compareExchange(words, index, state, SLOT_RETIRING);
        }
      }
      terminate();
      return outcome;
    },
  };
}
