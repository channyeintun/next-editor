// /dev and /dev/null are root's, so a user who is not root reads and lists
// /dev, writes /dev/null, and changes neither of them. Only what macOS answers
// the same way as Linux is here: Linux's 0755 /dev (macOS has 0555), its
// EACCES for a new entry (macOS's devfs says EPERM) and its EPERM for utimes
// (macOS EACCES) are in the unit tests.
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "dev-root-case");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, "mine"), "m");
fs.symlinkSync("/dev", path.join(dir, "devlink"));

const answer = (label, run) => {
  try {
    const value = run();
    console.log(label, "=>", value === undefined ? "ok" : JSON.stringify(value));
  } catch (error) {
    console.log(label, "=>", error.code, error.syscall);
  }
};
const owner = (target) => {
  const stat = fs.statSync(target);
  return [stat.uid, stat.gid, stat.isDirectory(), stat.isCharacterDevice()];
};

answer("stat /dev", () => owner("/dev"));
answer("stat devlink", () => owner(path.join(dir, "devlink")));
answer("stat /dev/null", () => [
  ...owner("/dev/null"),
  (fs.statSync("/dev/null").mode & 0o777).toString(8),
]);
answer("chmod /dev", () => fs.chmodSync("/dev", 0o777));
answer("chmod devlink", () => fs.chmodSync(path.join(dir, "devlink"), 0o777));
answer("chown /dev to me", () => fs.chownSync("/dev", process.getuid(), process.getgid()));
answer("chown /dev -1 -1", () => fs.chownSync("/dev", -1, -1));
answer("access /dev W_OK", () => fs.accessSync("/dev", fs.constants.W_OK));
answer("access /dev R_OK|X_OK", () => fs.accessSync("/dev", fs.constants.R_OK | fs.constants.X_OK));
answer("readdir /dev has null", () => fs.readdirSync("/dev").includes("null"));
answer("chmod /dev/null", () => fs.chmodSync("/dev/null", 0o600));
answer("chown /dev/null to me", () => fs.chownSync("/dev/null", process.getuid(), -1));
answer("link /dev/null", () => fs.linkSync("/dev/null", path.join(dir, "hl")));
answer("access /dev/null R_OK|W_OK", () =>
  fs.accessSync("/dev/null", fs.constants.R_OK | fs.constants.W_OK),
);
answer("write /dev/null", () => fs.writeFileSync("/dev/null", "x"));
answer("append devlink/null", () => fs.appendFileSync(path.join(dir, "devlink/null"), "x"));
answer("read /dev/null", () => fs.readFileSync("/dev/null").length);
answer("rmSync /dev/missing force", () => fs.rmSync("/dev/missing-entry", { force: true }));
answer("stat /dev after", () => owner("/dev"));
answer("chown mine to me", () =>
  fs.chownSync(path.join(dir, "mine"), process.getuid(), process.getgid()),
);
fs.rmSync(dir, { recursive: true, force: true });
