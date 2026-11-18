// The devices answer the same by every path that names them, through a link
// to / or to /dev as by their own spelling: /dev/fd is a directory, root's
// (as on macOS; Linux has a link to /proc there), and /dev/null a device,
// also to lstat and readlink, which do not follow the last link. On a
// descriptor of /dev/null, root's, the calls only its owner may make are
// refused; `touch`, which sets the times to now, needs only write access.
// /dev/fd/.. is /dev, by every path; a name after /dev/null goes through
// what is no directory (ENOTDIR). No device and no /dev can be hard-linked
// (EPERM), whatever path reaches it. Only what macOS answers as Linux does
// is here (Linux's EPERM for utimes and futimes, where macOS says EACCES,
// and its ENOTDIR for /dev/fd/0/.., where macOS says ENOENT, are in the
// unit tests).
const { execSync } = require("child_process");
const fs = require("fs");

const answer = (label, run) => {
  try {
    const value = run();
    console.log(label, "=>", value === undefined ? "ok" : JSON.stringify(value));
  } catch (error) {
    console.log(label, "=>", error.code, error.syscall);
  }
};

const links = { root: "spellings-root", dev: "spellings-dev" };
for (const link of Object.values(links)) {
  fs.rmSync(link, { force: true });
}
fs.symlinkSync("/", links.root);
fs.symlinkSync("/dev", links.dev);

const kind = (stat) =>
  stat.isDirectory()
    ? "directory"
    : stat.isCharacterDevice()
      ? "character device"
      : stat.isSymbolicLink()
        ? "link"
        : "other";
for (const path of ["/dev/fd", `${links.root}/dev/fd`, `${links.dev}/fd`]) {
  answer(`lstat ${path}`, () => [kind(fs.lstatSync(path)), fs.lstatSync(path).uid]);
  answer(`readdir ${path} has 0 1 2`, () =>
    ["0", "1", "2"].every((name) => fs.readdirSync(path).includes(name)),
  );
}
for (const path of ["/dev/null", `${links.root}/dev/null`, `${links.dev}/null`]) {
  answer(`lstat ${path}`, () => [kind(fs.lstatSync(path)), fs.lstatSync(path).uid]);
  answer(`readlink ${path}`, () => fs.readlinkSync(path));
}

// macOS's /dev/fd now and then answers a lookup of its `..` with ENOENT;
// a second try gives /dev.
const steady = (run) => {
  for (let tries = 1; ; tries++) {
    try {
      return run();
    } catch (error) {
      if (error.code !== "ENOENT" || tries === 3) {
        throw error;
      }
    }
  }
};
for (const path of [
  "/dev/fd/..",
  "/dev/fd/./..",
  `${links.root}/dev/fd/..`,
  `${links.dev}/fd/..`,
]) {
  answer(`lstat ${path}`, () => steady(() => [kind(fs.lstatSync(path)), fs.lstatSync(path).uid]));
  answer(`stat ${path}`, () => steady(() => [kind(fs.statSync(path)), fs.statSync(path).uid]));
  answer(`access ${path}`, () => steady(() => fs.accessSync(path)));
  answer(`realpath.native ${path}`, () => steady(() => fs.realpathSync.native(path)));
  answer(`readdir ${path} has fd and null`, () =>
    steady(() => ["fd", "null"].every((name) => fs.readdirSync(path).includes(name))),
  );
}
for (const path of ["/dev/null/..", `${links.dev}/null/..`, `${links.root}/dev/null/../null`]) {
  answer(`stat ${path}`, () => kind(fs.statSync(path)));
  answer(`lstat ${path}`, () => kind(fs.lstatSync(path)));
  answer(`readdir ${path}`, () => fs.readdirSync(path).length);
}

fs.rmSync("spellings-links", { recursive: true, force: true });
fs.mkdirSync("spellings-links");
for (const path of [
  "/dev/null",
  `${links.dev}/null`,
  `${links.root}/dev/tty`,
  `${links.dev}/fd`,
  "/dev",
  `${links.root}/dev`,
]) {
  answer(`link ${path}`, () => fs.linkSync(path, "spellings-links/x"));
}
answer("spellings-links after the links", () => fs.readdirSync("spellings-links"));
const linked = (line) =>
  execSync(`${line} 2>&1; echo $?`, { encoding: "utf8" }).trim().split("\n").pop();
console.log(`ln ${links.dev}/null:`, linked(`ln ${links.dev}/null spellings-links/y`));
fs.rmSync("spellings-links", { recursive: true });

const { O_DIRECTORY, O_RDONLY } = fs.constants;
for (const path of ["/dev/null", `${links.dev}/null`]) {
  answer(`open ${path} O_DIRECTORY`, () => {
    fs.closeSync(fs.openSync(path, O_RDONLY | O_DIRECTORY));
  });
}
const fd = fs.openSync("/dev/null", "r");
answer("fchmod /dev/null", () => fs.fchmodSync(fd, 0o600));
answer("fchown /dev/null to me", () => fs.fchownSync(fd, process.getuid(), process.getgid()));
answer("fchown /dev/null -1 -1", () => fs.fchownSync(fd, -1, -1));
fs.closeSync(fd);

const status = (line) => execSync(`${line} 2>/dev/null; echo $?`, { encoding: "utf8" }).trim();
console.log("touch /dev/null:", status("touch /dev/null"));
console.log(`touch ${links.dev}/null:`, status(`touch ${links.dev}/null`));
console.log("touch /dev:", status("touch /dev"));

for (const link of Object.values(links)) {
  fs.unlinkSync(link);
}
