console.log("hello", 1, true, null, undefined);
console.log({ a: 1, b: "two", c: [1, 2, 3], d: { e: { f: { g: 1 } } } });
console.log([1, "a", { x: 1 }], new Map([["k", 1]]), new Set([1, 2]));
console.log("%s is %d years and %j", "Bob", 42, { a: 1 });
console.log(Buffer.from("hi"), new Uint8Array([1, 2, 3]));
console.log(new Date(0).toISOString(), /re/g, Symbol("s"), 10n);
console.log(
  function named() {},
  class K {},
  () => {},
);
console.log(typeof process.stdout.write, typeof console.table);
console.info("info");
console.debug("debug");
// A table's cells are as wide as they look: colour codes take no column, a
// combining mark none, a wide character two.
const coloured = new console.Console({ stdout: process.stdout, colorMode: true });
coloured.table([
  { a: 1, b: true, c: "str" },
  { a: 22222, b: false, c: null },
]);
console.table([
  { name: "မောင်မောင်", n: 1 },
  { name: "日本語", n: 2 },
  { name: "é ✅", n: 3 },
]);
// The members loggers reach for.
console.log(
  console._stdout === process.stdout,
  console._stderr === process.stderr,
  typeof console._stdoutErrorHandler,
  console._ignoreErrors,
  Object.keys(new console.Console(process.stdout)).length,
);
