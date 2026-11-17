// The mutex every worker takes around a call into the shared filesystem. The
// Rust code is single-threaded: it is this lock that makes one worker's call
// finish before the next begins, so the instances can share one memory, and
// one stack, safely.
//
// A three-state futex mutex over one Int32 word: 0 free, 1 held, 2 held with
// (possible) waiters. A worker that has waited always takes the lock as 2, so
// that its own unlock wakes the next waiter. Taking it as 1 after a wait would
// leave the others asleep for good.

const FREE = 0;
const HELD = 1;
const CONTENDED = 2;

/** Takes the lock at `words[index]`, sleeping while another worker holds it. */
export function acquireLock(words: Int32Array, index: number): void {
  let state = Atomics.compareExchange(words, index, FREE, HELD);
  if (state === FREE) {
    return;
  }
  if (state !== CONTENDED) {
    state = Atomics.exchange(words, index, CONTENDED);
  }
  while (state !== FREE) {
    Atomics.wait(words, index, CONTENDED);
    state = Atomics.exchange(words, index, CONTENDED);
  }
}

/** Releases the lock at `words[index]` and wakes one waiter, if any may be waiting. */
export function releaseLock(words: Int32Array, index: number): void {
  if (Atomics.exchange(words, index, FREE) === CONTENDED) {
    Atomics.notify(words, index, 1);
  }
}
