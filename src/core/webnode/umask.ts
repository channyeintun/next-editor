// The file mode creation mask, umask(2): the permission bits taken off the
// mode of each file and directory a process creates. Every process has its
// own, a child starts with a copy of its parent's, and the threads of a
// process share one. The filesystems apply it (kernel/vfs/vfs.ts
// `creationMode`, sharedfs/crate/src/fs.rs `creation_mode`); this module owns
// the default, what a mask may hold, and where a process's mask is kept.

/** The mask a process starts with unless it inherits another. */
export const DEFAULT_UMASK = 0o022;

/** What a mask keeps of the number it is set to, as Linux's umask(2): the permission bits. */
export function umaskBits(mask: number): number {
  return mask & 0o777;
}

/**
 * One process's mask: a word of shared memory. The process sets it, its
 * threads and the kernel read it there, so a change is seen at once by
 * everything that creates a file for the process. Sent to another worker it
 * stays the same word.
 */
export type UmaskCell = Int32Array;

/** A cell of its own holding `mask`: what a new process gets. */
export function createUmaskCell(mask: number): UmaskCell {
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  writeUmask(cell, mask);
  return cell;
}

export function readUmask(cell: UmaskCell): number {
  return umaskBits(Atomics.load(cell, 0));
}

/** Sets the mask to the permission bits of `mask` and returns what it was. */
export function writeUmask(cell: UmaskCell, mask: number): number {
  return umaskBits(Atomics.exchange(cell, 0, umaskBits(mask)));
}
