const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "tmp-fs-case");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "a/b"), { recursive: true });
fs.writeFileSync(path.join(dir, "a/one.txt"), "one");
fs.appendFileSync(path.join(dir, "a/one.txt"), "+two");
console.log(fs.readFileSync(path.join(dir, "a/one.txt"), "utf8"));
console.log(fs.readdirSync(path.join(dir, "a")).sort());
console.log(fs.readdirSync(dir, { withFileTypes: true }).map((e) => [e.name, e.isDirectory()]));
const stat = fs.statSync(path.join(dir, "a/one.txt"));
console.log(stat.isFile(), stat.size, stat.mtime instanceof Date);
fs.renameSync(path.join(dir, "a/one.txt"), path.join(dir, "a/b/moved.txt"));
console.log(
  fs.existsSync(path.join(dir, "a/one.txt")),
  fs.existsSync(path.join(dir, "a/b/moved.txt")),
);
fs.symlinkSync("b/moved.txt", path.join(dir, "a/link"));
console.log(
  fs.readlinkSync(path.join(dir, "a/link")),
  fs.lstatSync(path.join(dir, "a/link")).isSymbolicLink(),
);
console.log(fs.realpathSync(path.join(dir, "a/link")) === path.join(dir, "a/b/moved.txt"));
try {
  fs.readFileSync(path.join(dir, "missing"));
} catch (error) {
  console.log(error.code, error.syscall, error.errno < 0);
}
const fd = fs.openSync(path.join(dir, "fd.txt"), "w+");
fs.writeSync(fd, "abcdef");
const buffer = Buffer.alloc(3);
console.log(fs.readSync(fd, buffer, 0, 3, 2), buffer.toString());
fs.closeSync(fd);
fs.promises
  .readFile(path.join(dir, "fd.txt"), "utf8")
  .then((text) => {
    console.log("promise", text);
    return new Promise((resolve) =>
      fs.readFile(path.join(dir, "fd.txt"), (error, data) => resolve([error, data.length])),
    );
  })
  .then((result) => {
    console.log("callback", result);
    const chunks = [];
    fs.createReadStream(path.join(dir, "fd.txt"), { highWaterMark: 2 })
      .on("data", (chunk) => chunks.push(chunk.toString()))
      .on("end", () => {
        console.log("stream", chunks);
        fs.rmSync(dir, { recursive: true });
        console.log(fs.existsSync(dir));
      });
  });
