const { Readable, Transform, pipeline } = require("stream");
const crypto = require("crypto");
const zlib = require("zlib");
const { EventEmitter, once } = require("events");
const readline = require("readline");
const { StringDecoder } = require("string_decoder");
const util = require("util");

const upper = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, chunk.toString().toUpperCase());
  },
});
const chunks = [];
pipeline(
  Readable.from(["a", "b", "c"]),
  upper,
  async function (source) {
    for await (const chunk of source) chunks.push(String(chunk));
  },
  (error) => {
    console.log("pipeline", error, chunks.join(""));
    console.log(crypto.createHash("sha256").update("abc").digest("hex"));
    console.log(crypto.createHash("md5").update("abc").digest("base64"));
    console.log(crypto.createHmac("sha1", "key").update("data").digest("hex"));
    console.log(
      crypto.randomBytes(8).length,
      crypto.randomUUID().length,
      typeof crypto.webcrypto.subtle,
    );
    const packed = zlib.gzipSync("hello hello hello hello");
    console.log(
      zlib.gunzipSync(packed).toString(),
      zlib.inflateSync(zlib.deflateSync(Buffer.from("xyz"))).toString(),
    );
    const emitter = new EventEmitter();
    once(emitter, "ready").then(([value]) => {
      console.log("once", value);
      console.log(
        util.inspect({ a: [1, { b: 2 }], s: "x" }, { depth: 0 }),
        util.format("%o", [1]),
        util.types.isPromise(Promise.resolve()),
      );
      console.log(
        util.promisify((x, cb) => cb(null, x + 1))(1) instanceof Promise,
        util.isDeepStrictEqual({ a: [1] }, { a: [1] }),
      );
      more().catch((error) => console.log("FAILED", error));
    });
    emitter.emit("ready", 5);
  },
);

const show = (chunk) => (chunk === null ? "null" : String(chunk));
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function more() {
  // StringDecoder is a plain function: iconv-lite 0.4 (Express 4's body
  // parsers) calls it on its own objects, which share its prototype.
  function InternalDecoder(encoding) {
    StringDecoder.call(this, encoding);
  }
  InternalDecoder.prototype = StringDecoder.prototype;
  const decoder = new InternalDecoder("utf8");
  const bytes = Buffer.from("h\u00e9llo");
  console.log(
    "decoder",
    decoder.write(bytes.subarray(0, 2)) + decoder.end(bytes.subarray(2)),
    decoder instanceof StringDecoder,
    Object.keys(decoder),
  );
  try {
    StringDecoder("utf8");
    console.log("StringDecoder with no this: returned");
  } catch (error) {
    console.log("StringDecoder with no this:", error.name, typeof globalThis.encoding);
  }

  // A paused stream is read chunk by chunk, whatever stands for "no size".
  const reads = new Readable({ read() {} });
  reads.push("a");
  reads.push("b");
  reads.push("c");
  console.log("read", show(reads.read(null)), show(reads.read(NaN)), show(reads.read()));
  const sizes = [];
  const marked = new Readable({
    highWaterMark: 4,
    read(size) {
      sizes.push(size);
    },
  });
  marked.push("abcdefghijklmnop");
  marked.push("q");
  console.log("_read", show(marked.read()), show(marked.read()), sizes.join(","));
  const atOnce = new Readable({
    read() {
      this.push("x");
      this.push("y");
      this.push(null);
    },
  });
  console.log("pushed at once", show(atOnce.read()), show(atOnce.read()), show(atOnce.read()));

  // A stream that ended before anybody listened tells its first 'readable'
  // listener once.
  const looped = [];
  await new Promise((resolve) => {
    const ended = new Readable({ read() {} });
    ended.push("a");
    ended.push("b");
    ended.push(null);
    ended.on("readable", () => {
      looped.push("readable");
      for (let chunk = ended.read(); chunk !== null; chunk = ended.read()) looped.push(show(chunk));
    });
    ended.on("end", resolve);
  });
  console.log("ended unobserved:", looped.join(" "));
  const single = [];
  const stalled = new Readable({ read() {} });
  stalled.push("a");
  stalled.push("b");
  stalled.push(null);
  stalled.on("readable", () => single.push(show(stalled.read())));
  stalled.on("end", () => single.push("end"));
  await turn();
  await turn();
  console.log("one read per 'readable':", single.join(" "), stalled.readableLength);

  // A job's callback is a task of the event loop: its ticks run before its
  // promise jobs.
  const jobs = {
    "zlib.gzip": (done) => zlib.gzip("hello", done),
    "crypto.randomBytes": (done) => crypto.randomBytes(8, done),
    "crypto.randomFill": (done) => crypto.randomFill(new Uint8Array(8), done),
    "crypto.randomInt": (done) => crypto.randomInt(10, done),
    "crypto.pbkdf2": (done) => crypto.pbkdf2("pw", "salt", 10, 16, "sha256", done),
    "crypto.pbkdf2 of no bytes": (done) => crypto.pbkdf2("pw", "salt", 10, 0, "sha256", done),
    "crypto.scrypt": (done) => crypto.scrypt("pw", "salt", 16, { N: 16 }, done),
    "crypto.scrypt of no bytes": (done) => crypto.scrypt("pw", "salt", 0, done),
    "crypto.hkdf": (done) => crypto.hkdf("sha256", "key", "salt", "info", 16, done),
  };
  for (const [name, start] of Object.entries(jobs)) {
    const order = await new Promise((resolve) => {
      const log = [];
      start((error) => {
        log.push(error ? "error" : "callback");
        process.nextTick(() => log.push("tick"));
        Promise.resolve().then(() => log.push("promise"));
        setImmediate(() => resolve(log));
      });
      log.push("returned");
    });
    console.log(name + ":", order.join(" "));
  }

  // A 'line' listener that closes the interface still gets the lines that
  // came in the same chunk.
  const lines = [];
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: Readable.from(["a\nb\nc\nd\n"]) });
    rl.on("line", (line) => {
      lines.push(line);
      if (line === "b") rl.close();
    });
    rl.on("close", () => setImmediate(resolve));
  });
  console.log("close in a 'line' listener:", lines.join(" "));

  // Fake timers: what a program puts in place of the global timers must not
  // hold back a builtin's own work.
  const globals = ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"];
  const saved = globals.map((name) => globalThis[name]);
  const parked = [];
  for (const name of globals) globalThis[name] = (callback) => void parked.push(callback);
  let finished;
  try {
    const packed = await util.promisify(zlib.gzip)("faked");
    finished = [
      zlib.gunzipSync(packed).toString(),
      (await util.promisify(crypto.randomBytes)(4)).length,
      (await util.promisify(crypto.pbkdf2)("pw", "salt", 1, 4, "sha1")).length,
      (await util.promisify(crypto.scrypt)("pw", "salt", 0)).length,
      (await util.promisify(crypto.hkdf)("sha256", "key", "salt", "info", 8)).byteLength,
      await util.promisify(readline.cursorTo)(null, 0, 0),
    ];
  } finally {
    globals.forEach((name, index) => (globalThis[name] = saved[index]));
  }
  console.log("with the global timers replaced:", finished.join(" "), parked.length);
}
