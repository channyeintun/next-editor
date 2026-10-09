/**
 * The program's address space, one page at a time.
 *
 * A 64-bit address space cannot be an array, and it does not need to be: a
 * lesson program touches a few pages of code, a page of data, and the top of
 * the stack — three regions separated by hundreds of gigabytes of nothing. So
 * pages are created when they are first written and looked up in a map, which
 * makes the stack at 0x7ffffffff000 cost the same as the code at 0x401000.
 *
 * Reading a page that was never mapped is a fault rather than a zero. That is
 * the whole value of the model for teaching: `mov rax, [0]` should not quietly
 * return 0, it should say the program touched an address that is not part of
 * it — which is exactly what the operating system would say.
 */

export const PAGE_BITS = 12n;
export const PAGE_BYTES = 1 << Number(PAGE_BITS);
const PAGE_MASK = BigInt(PAGE_BYTES - 1);

export type PagePermission = "r" | "rw" | "rx";

export class MemoryFault extends Error {
  readonly address: bigint;
  readonly access: "read" | "write" | "execute";

  constructor(message: string, address: bigint, access: "read" | "write" | "execute") {
    super(message);
    this.name = "MemoryFault";
    this.address = address;
    this.access = access;
  }
}

interface Page {
  /** Allocated on first touch — a reserved page nobody writes costs nothing. */
  data: Uint8Array | null;
  /** `data` read as words, made the first time a word is read or written. */
  view: DataView | null;
  permission: PagePermission;
}

function formatAddress(address: bigint): string {
  return `0x${(address & 0xffff_ffff_ffff_ffffn).toString(16)}`;
}

export class Memory {
  #pages = new Map<bigint, Page>();
  /** The half-open spans that hold real instructions, in mapping order. */
  #code: { start: bigint; end: bigint }[] = [];

  /** Map a region, creating pages as needed and copying `bytes` into it. */
  map(start: bigint, length: bigint, permission: PagePermission, bytes?: Uint8Array): void {
    // `length` is separate because .bss, the stack and the heap map space with
    // no bytes behind it. Bytes that overrun it would land on pages this call
    // never created, so that is the loader's mistake and is said so here.
    if (bytes && BigInt(bytes.length) > length) {
      throw new RangeError(`map: ${bytes.length} bytes do not fit in ${length}`);
    }
    const first = start >> PAGE_BITS;
    const last = (start + (length > 0n ? length - 1n : 0n)) >> PAGE_BITS;
    for (let page = first; page <= last; page += 1n) {
      if (!this.#pages.has(page)) this.#pages.set(page, { data: null, view: null, permission });
    }
    // Pages are the unit of permission, but the last code page has zeros after
    // the last instruction, and those zeros are `add [rax], al` to a decoder.
    // Remembering where the code really ends is what lets a program that ran
    // off the end of itself be told so, instead of being blamed for whatever
    // address the padding happened to dereference.
    if (permission === "rx" && length > 0n) this.#code.push({ start, end: start + length });
    if (bytes) {
      // The loader writes through the permission check, not around it: this is
      // the kernel placing the program in memory before it starts, and code
      // pages are read-only *to the program*, not to whoever mapped them.
      for (let offset = 0; offset < bytes.length; offset += 1) {
        const address = start + BigInt(offset);
        // The guard above keeps every byte inside the pages just created.
        const page = this.#pages.get(address >> PAGE_BITS)!;
        this.#bytesOf(page)[Number(address & PAGE_MASK)] = bytes[offset];
      }
    }
  }

  isMapped(address: bigint): boolean {
    return this.#pages.has(address >> PAGE_BITS);
  }

  #bytesOf(page: Page): Uint8Array {
    page.data ??= new Uint8Array(PAGE_BYTES);
    return page.data;
  }

  #isCode(address: bigint): boolean {
    for (const span of this.#code) {
      if (address >= span.start && address < span.end) return true;
    }
    return false;
  }

  #page(address: bigint, access: "read" | "write" | "execute"): Page {
    const page = this.#pages.get(address >> PAGE_BITS);
    if (!page) {
      throw new MemoryFault(
        access === "execute"
          ? `The program tried to run the bytes at ${formatAddress(address)}, which are not part of it`
          : `The program tried to ${access} ${formatAddress(address)}, which is not part of it`,
        address,
        access,
      );
    }
    if (access === "write" && page.permission !== "rw") {
      throw new MemoryFault(
        `The program tried to write to ${formatAddress(address)}, which is read-only`,
        address,
        access,
      );
    }
    if (access === "execute" && page.permission !== "rx") {
      throw new MemoryFault(
        `The program tried to run the bytes at ${formatAddress(address)}, which are not code`,
        address,
        access,
      );
    }
    if (access === "execute" && !this.#isCode(address)) {
      throw new MemoryFault(
        `The program ran past its last instruction, at ${formatAddress(address)} — nothing follows the code, so a program has to call exit itself`,
        address,
        access,
      );
    }
    return page;
  }

  #viewOf(page: Page): DataView {
    page.view ??= new DataView(this.#bytesOf(page).buffer);
    return page.view;
  }

  #load(address: bigint): number {
    const page = this.#page(address, "read");
    return page.data === null ? 0 : page.data[Number(address & PAGE_MASK)];
  }

  #store(address: bigint, value: number): void {
    const page = this.#page(address, "write");
    this.#bytesOf(page)[Number(address & PAGE_MASK)] = value & 0xff;
  }

  /**
   * Read a little-endian value of `size` bytes.
   *
   * Every memory operand, push, pop, call and ret comes through here and
   * `write`, so a value that sits inside one page — nearly all of them —
   * resolves that page once and reads the word whole. Only a value that runs
   * onto the next page is walked a byte at a time.
   */
  read(address: bigint, size: number): bigint {
    const at = Number(address & PAGE_MASK);
    if (at + size <= PAGE_BYTES) {
      const page = this.#page(address, "read");
      if (page.data === null) return 0n;
      switch (size) {
        case 1:
          return BigInt(page.data[at]);
        case 2:
          return BigInt(this.#viewOf(page).getUint16(at, true));
        case 4:
          return BigInt(this.#viewOf(page).getUint32(at, true));
        case 8:
          return this.#viewOf(page).getBigUint64(at, true);
      }
    }
    let value = 0n;
    for (let offset = 0; offset < size; offset += 1) {
      value |= BigInt(this.#load(address + BigInt(offset))) << BigInt(offset * 8);
    }
    return value;
  }

  write(address: bigint, size: number, value: bigint): void {
    const at = Number(address & PAGE_MASK);
    if (at + size <= PAGE_BYTES) {
      const page = this.#page(address, "write");
      switch (size) {
        case 1:
          this.#bytesOf(page)[at] = Number(value & 0xffn);
          return;
        case 2:
          this.#viewOf(page).setUint16(at, Number(value & 0xffffn), true);
          return;
        case 4:
          this.#viewOf(page).setUint32(at, Number(value & 0xffff_ffffn), true);
          return;
        case 8:
          // setBigUint64 keeps the low 64 bits, as the byte loop does.
          this.#viewOf(page).setBigUint64(at, value, true);
          return;
      }
    } else {
      // A store that runs onto the next page checks both pages before it
      // writes anything, so a fault on the second leaves the first as it was
      // rather than half-written. The fault still names the second page's
      // first byte, the address the byte loop below would have stopped on.
      this.#page(address, "write");
      this.#page((address | PAGE_MASK) + 1n, "write");
    }
    for (let offset = 0; offset < size; offset += 1) {
      this.#store(address + BigInt(offset), Number((value >> BigInt(offset * 8)) & 0xffn));
    }
  }

  /** Read `length` bytes for a syscall — the same permission rules apply. */
  readBytes(address: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 1) {
      out[offset] = this.#load(address + BigInt(offset));
    }
    return out;
  }

  writeBytes(address: bigint, bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.length; offset += 1) {
      this.#store(address + BigInt(offset), bytes[offset]);
    }
  }

  /**
   * Copy out the instruction bytes at an address, for the decoder.
   *
   * The first byte is a real execute access, so a jump to an address that is
   * not code fails *here*, naming what the program was trying to do. Left to
   * the tail rule below it would still fail — 0x00 0x00 decodes to
   * `add [rax], al`, which then faults on a bad data address — but the message
   * would say the program tried to *read* somewhere it never meant to touch,
   * which is exactly the wrong thing to tell someone whose jump went wrong.
   *
   * Reading past the end of the last code page is normal, because the decoder
   * asks for a maximum-length window and a short instruction at the end of a
   * section would otherwise fault on bytes it never uses. Those tail bytes read
   * as zero and the decoder stops when it has enough.
   *
   * This runs for every instruction the machine decodes — once per distinct
   * address, since it caches what it decoded — so the common case, a window
   * that stays inside one page, resolves that page once and hands the decoder a
   * view of it, rather than walking the page table per byte.
   */
  readCode(address: bigint, length: number): Uint8Array {
    const page = this.#page(address, "execute");
    const offset = Number(address & PAGE_MASK);
    if (page.data !== null && offset + length <= PAGE_BYTES) {
      return page.data.subarray(offset, offset + length);
    }
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      const at = address + BigInt(index);
      out[index] = this.isMapped(at) ? this.#load(at) : 0;
    }
    return out;
  }
}
