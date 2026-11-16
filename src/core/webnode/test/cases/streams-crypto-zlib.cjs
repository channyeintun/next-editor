const { Readable, Transform, pipeline } = require("stream");
const crypto = require("crypto");
const zlib = require("zlib");
const { EventEmitter, once } = require("events");
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
    });
    emitter.emit("ready", 5);
  },
);
