// Builds webnode's shared filesystem (src/core/webnode/sharedfs/crate, Rust) to
// the committed module in src/core/webnode/sharedfs/wasm.generated.ts.
//
//   bun run build:webnode-fs
//
// Three stages:
//   1. `cargo build` for wasm32-unknown-unknown (stable Rust, no dependencies,
//      so no network).
//   2. Make the module shareable (shareMemory below): every worker of a runtime
//      instantiates it on ONE shared memory.
//   3. `wasm-opt` (Binaryen) to shrink it.
// The result is committed so tests and deploys need no Rust toolchain; only
// regenerating it does. Requires the wasm32-unknown-unknown target
// (`rustup target add wasm32-unknown-unknown`) and `wasm-opt`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = resolve(root, "src/core/webnode/sharedfs");
const crateDir = resolve(moduleDir, "crate");
const rawWasm = resolve(crateDir, "target/wasm32-unknown-unknown/release/webnode_sharedfs.wasm");
const outFile = resolve(moduleDir, "wasm.generated.ts");

const SECTION_IMPORT = 2;
const SECTION_START = 8;
const SECTION_CODE = 10;
const SECTION_DATA = 11;
const SECTION_DATA_COUNT = 12;

function readLeb(bytes, at) {
  let value = 0;
  let shift = 0;
  let index = at;
  for (;;) {
    const byte = bytes[index++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      return { value, next: index };
    }
  }
}

function readSignedLeb(bytes, at) {
  let value = 0;
  let shift = 0;
  let index = at;
  let byte;
  do {
    byte = bytes[index++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) {
    value |= -1 << shift;
  }
  return { value, next: index };
}

function writeLeb(value) {
  const out = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (rest !== 0);
  return out;
}

/**
 * Throws unless function `index` of the code section at `sectionStart` is
 * exactly one `memory.fill` of zeros: what the linker emits to clear the static
 * area. A start function that did anything more (static constructors, a later
 * toolchain's idea) cannot simply be dropped.
 */
function assertOnlyZeroFills(bytes, sectionStart, index) {
  let p = readLeb(bytes, sectionStart).next;
  for (let i = 0; i < index; i += 1) {
    const size = readLeb(bytes, p);
    p = size.next + size.value;
  }
  const size = readLeb(bytes, p);
  const end = size.next + size.value;
  p = size.next;
  const expect = (condition) => {
    if (!condition) {
      throw new Error(
        "the start function is not a single zero-fill of the static area: it cannot be dropped",
      );
    }
  };
  expect(bytes[p++] === 0x00); // no locals
  expect(bytes[p++] === 0x41); // i32.const <address>
  p = readSignedLeb(bytes, p).next;
  expect(bytes[p++] === 0x41 && bytes[p++] === 0x00); // i32.const 0
  expect(bytes[p++] === 0x41); // i32.const <length>
  p = readSignedLeb(bytes, p).next;
  expect(bytes[p++] === 0xfc && bytes[p++] === 0x0b && bytes[p++] === 0x00); // memory.fill 0
  expect(bytes[p++] === 0x0b && p === end); // end
}

/**
 * Makes a module that imports a plain memory into one whose every instance runs
 * on the same shared memory:
 *
 * - the memory import is marked shared (the code needs no atomic instructions:
 *   the callers serialise their calls with a lock, sharedfs/lock.ts);
 * - the data section is taken out and returned, to be written into the memory
 *   once. Left in, every instantiation would write the initial values of the
 *   statics over what the other instances had stored there;
 * - the start function is taken out. The linker adds it to zero-fill the static
 *   area, since it cannot assume an imported memory is clean; run by every
 *   instance it would wipe the shared state. A new WebAssembly.Memory is zero.
 */
export function shareMemory(input) {
  const bytes = new Uint8Array(input);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("not a WebAssembly module");
  }
  const out = [...bytes.subarray(0, 8)];
  const segments = [];
  let memory = null;
  let importedFunctions = 0;
  let startFunction = null;
  let startChecked = false;
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at];
    const size = readLeb(bytes, at + 1);
    const start = size.next;
    const end = start + size.value;
    if (id === SECTION_IMPORT) {
      const section = bytes.slice(start, end);
      let p = 0;
      const count = readLeb(section, p);
      p = count.next;
      for (let i = 0; i < count.value; i += 1) {
        for (let name = 0; name < 2; name += 1) {
          const length = readLeb(section, p);
          p = length.next + length.value;
        }
        const kind = section[p++];
        if (kind === 0) {
          importedFunctions += 1;
          p = readLeb(section, p).next;
        } else if (kind === 1) {
          p += 1;
          const flags = section[p++];
          p = readLeb(section, p).next;
          if (flags & 1) {
            p = readLeb(section, p).next;
          }
        } else if (kind === 2) {
          if (memory) {
            throw new Error("the module imports more than one memory");
          }
          const flagsAt = p;
          const flags = section[p++];
          const minimum = readLeb(section, p);
          p = minimum.next;
          if ((flags & 1) === 0) {
            throw new Error("the memory import has no maximum: link with --max-memory");
          }
          if (flags & ~1) {
            throw new Error(`the memory import has flags this script does not expect: ${flags}`);
          }
          const maximum = readLeb(section, p);
          p = maximum.next;
          section[flagsAt] = flags | 2;
          memory = { initial: minimum.value, maximum: maximum.value };
        } else if (kind === 3) {
          p += 2;
        } else {
          throw new Error(`unknown import kind ${kind}`);
        }
      }
      out.push(id, ...writeLeb(section.length), ...section);
    } else if (id === SECTION_DATA) {
      let p = start;
      const count = readLeb(bytes, p);
      p = count.next;
      for (let i = 0; i < count.value; i += 1) {
        const flag = readLeb(bytes, p);
        p = flag.next;
        if (flag.value !== 0) {
          throw new Error(`data segment ${i} is not an active segment of memory 0`);
        }
        if (bytes[p++] !== 0x41) {
          throw new Error(`data segment ${i} has an offset that is not an i32.const`);
        }
        const offset = readSignedLeb(bytes, p);
        p = offset.next;
        if (bytes[p++] !== 0x0b) {
          throw new Error(`data segment ${i} has an offset that is not one constant`);
        }
        const length = readLeb(bytes, p);
        p = length.next;
        segments.push({ offset: offset.value >>> 0, bytes: bytes.slice(p, p + length.value) });
        p += length.value;
      }
    } else if (id === SECTION_START) {
      // Dropped, once the code section has shown it only zero-fills (below).
      startFunction = readLeb(bytes, start).value;
    } else if (id === SECTION_DATA_COUNT) {
      // Dropped with the data section.
    } else {
      if (id === SECTION_CODE && startFunction !== null) {
        assertOnlyZeroFills(bytes, start, startFunction - importedFunctions);
        startChecked = true;
      }
      out.push(...bytes.subarray(at, end));
    }
    at = end;
  }
  if (!memory) {
    throw new Error("the module imports no memory: link with --import-memory");
  }
  if (startFunction !== null && !startChecked) {
    throw new Error("the module has a start function but its code was not found");
  }
  return { wasm: new Uint8Array(out), segments, memory };
}

/**
 * Checks the module that ships, after every tool has had its turn: a toolchain
 * update must not be able to bring back what `shareMemory` took out. Throws
 * unless the module has no start function and no data, imports exactly a
 * shared memory with a maximum and the clock, and validates.
 */
export function assertShareable(input) {
  const bytes = new Uint8Array(input);
  let memoryFlags = null;
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at];
    const size = readLeb(bytes, at + 1);
    const start = size.next;
    if (id === SECTION_START) {
      throw new Error("the built module has a start function: every instance would run it");
    }
    if (id === SECTION_DATA || id === SECTION_DATA_COUNT) {
      throw new Error("the built module has data: every instance would write it again");
    }
    if (id === SECTION_IMPORT) {
      let p = start;
      const count = readLeb(bytes, p);
      p = count.next;
      for (let i = 0; i < count.value; i += 1) {
        for (let name = 0; name < 2; name += 1) {
          const length = readLeb(bytes, p);
          p = length.next + length.value;
        }
        const kind = bytes[p++];
        if (kind === 0) {
          p = readLeb(bytes, p).next;
        } else if (kind === 2) {
          memoryFlags = bytes[p++];
          p = readLeb(bytes, p).next;
          if (memoryFlags & 1) {
            p = readLeb(bytes, p).next;
          }
        } else {
          throw new Error(`the built module has an import of kind ${kind}`);
        }
      }
    }
    at = start + size.value;
  }
  if (memoryFlags !== 3) {
    throw new Error(
      `the built module's memory import is not shared with a maximum (flags ${memoryFlags})`,
    );
  }
  if (!WebAssembly.validate(bytes)) {
    throw new Error("the built module does not validate");
  }
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
  const names = imports.map((entry) => `${entry.module}.${entry.name}`).sort();
  if (names.join(",") !== "env.memory,env.now") {
    throw new Error(`the built module imports ${names.join(", ")}, not its memory and clock alone`);
  }
}

/** The files the module is built from (this script among them), relative to sharedfs/, in a fixed order. */
function sourceFiles() {
  const files = ["crate/Cargo.toml", relative(moduleDir, fileURLToPath(import.meta.url))];
  const walk = (directory) => {
    for (const entry of readdirSync(resolve(moduleDir, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".rs")) {
        files.push(path);
      }
    }
  };
  walk("crate/src");
  return files.sort();
}

/** One hash over the source files' contents, in order. */
function hashOf(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(moduleDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

/**
 * The compiler flags of the module that ships. The memory is imported, so that
 * every instance can be given the same one (`shareMemory` then marks the import
 * shared); its maximum is the whole 32-bit address space, and a host that
 * cannot reserve that offers a smaller memory. The source paths the compiler
 * writes into panic messages are renamed: they would put this machine's home
 * directory into a script every visitor downloads.
 */
function rustFlags() {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  return [
    "-Clink-arg=--import-memory",
    "-Clink-arg=--max-memory=4294967296",
    "-Clink-arg=-zstack-size=1048576",
    // The last prefix that matches wins: the general one first.
    `--remap-path-prefix=${homedir()}=/builder`,
    `--remap-path-prefix=${crateDir}=/crate`,
    `--remap-path-prefix=${sysroot}=/rust`,
  ];
}

/** The features the module uses, for the optimizer: no others may appear in what it writes. */
const WASM_FEATURES = [
  "threads",
  "bulk-memory",
  "bulk-memory-opt",
  "call-indirect-overlong",
  "multivalue",
  "mutable-globals",
  "nontrapping-float-to-int",
  "reference-types",
  "sign-ext",
];

function build() {
  try {
    run(
      "cargo",
      [
        "build",
        "--release",
        "--offline",
        "--target",
        "wasm32-unknown-unknown",
        "--manifest-path",
        resolve(crateDir, "Cargo.toml"),
      ],
      { cwd: crateDir, env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustFlags().join("\x1f") } },
    );
  } catch {
    console.error(
      "\ncargo build failed. Install Rust (https://rustup.rs) and the wasm target:\n" +
        "  rustup target add wasm32-unknown-unknown\n",
    );
    process.exit(1);
  }

  const shared = shareMemory(readFileSync(rawWasm));
  const scratch = mkdtempSync(join(tmpdir(), "webnode-fs-"));
  const sharedPath = join(scratch, "shared.wasm");
  const optimizedPath = join(scratch, "optimized.wasm");
  let optimized;
  try {
    writeFileSync(sharedPath, shared.wasm);
    try {
      // `threads` allows the shared memory the module now imports; `-O3`
      // optimizes for speed.
      run("wasm-opt", [
        ...WASM_FEATURES.map((feature) => `--enable-${feature}`),
        "-O3",
        "-o",
        optimizedPath,
        sharedPath,
      ]);
    } catch {
      console.error(
        "\nwasm-opt not found or failed. Install Binaryen (e.g. `brew install binaryen`).\n",
      );
      process.exit(1);
    }
    optimized = readFileSync(optimizedPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  assertShareable(optimized);
  for (const part of [optimized, ...shared.segments.map((segment) => segment.bytes)]) {
    const text = Buffer.from(part).toString("latin1");
    const leak =
      /\/(?:Users|home)\/[^\0/]+\/[^\0]{0,60}/.exec(text) ??
      /[A-Za-z]:\\Users\\[^\0]{0,60}/.exec(text);
    if (leak) {
      throw new Error(`the built module names a path of this machine: ${leak[0]}`);
    }
  }
  const sources = sourceFiles();

  const base64 = (bytes) => Buffer.from(bytes).toString("base64");
  // Laid out as the formatter would, so a rebuild of unchanged source changes nothing.
  const segments = shared.segments
    .map((segment) => `  [\n    ${segment.offset},\n    "${base64(segment.bytes)}",\n  ],`)
    .join("\n");
  writeFileSync(
    outFile,
    `// Generated by scripts/build-webnode-fs-wasm.mjs from sharedfs/crate. Do not edit:
// change the Rust source and run \`bun run build:webnode-fs\`.

/** The filesystem module, base64. It imports a shared memory (\`env.memory\`) and a clock (\`env.now\`). */
export const SHARED_FS_WASM_BASE64 =
  "${base64(optimized)}";

/** The module's initial data, by address: written into a new memory once, by the worker that creates it. */
export const SHARED_FS_DATA_SEGMENTS: readonly (readonly [address: number, base64: string])[] = [
${segments}
];

/** The memory the module imports, in 64 KiB pages. */
export const SHARED_FS_MEMORY = { initial: ${shared.memory.initial}, maximum: ${shared.memory.maximum} } as const;

/** The files the module was built from, relative to this directory. */
export const SHARED_FS_SOURCE_FILES = [
${sources.map((file) => `  "${file}",`).join("\n")}
] as const;

/** A hash of those files as they were then: a test fails when they have changed since. */
export const SHARED_FS_SOURCE_HASH =
  "${hashOf(sources)}";
`,
  );
  const dataBytes = shared.segments.reduce((total, segment) => total + segment.bytes.length, 0);
  console.log(
    `\nbuilt ${outFile}\n  module ${optimized.length} bytes, ${shared.segments.length} data segment(s) of ${dataBytes} bytes, memory ${shared.memory.initial}..${shared.memory.maximum} pages`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build();
}
