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
