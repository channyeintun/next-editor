// File permissions, as Linux enforces them for a user who owns every file and
// is not root: search on every directory a path goes through, read to read or
// list, write to change a file, write and search on a directory to change its
// entries, execute to run. Only what macOS does the same way is here (the rest
// is in the unit tests). Every mode is given back at the end, even when a step
// throws, so the case's directory can be removed.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(process.cwd(), "perm-case");
const changed = new Set();
const show = (text) => String(text).split(process.cwd()).join("<cwd>");

function mode(target, bits) {
  fs.chmodSync(target, bits);
  changed.add(target);
}

function step(label, run) {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "" : JSON.stringify(value));
  } catch (error) {
    console.log(label, error.code, error.syscall, error.errno, show(error.message));
  }
}

async function stepAsync(label, run) {
  try {
    const value = await run();
    console.log(label, "ok", value === undefined ? "" : JSON.stringify(value));
  } catch (error) {
    console.log(label, error.code, error.syscall, error.errno, show(error.message));
  }
}

function restore() {
  for (const target of [...changed].reverse()) {
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      // Removed by a step.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  const at = (name) => path.join(root, name);

  // A file's own bits.
  fs.writeFileSync(at("f"), "data");
  mode(at("f"), 0);
  step("read 000", () => fs.readFileSync(at("f"), "utf8"));
  step("write 000", () => fs.writeFileSync(at("f"), "x"));
  step("stat 000", () => fs.statSync(at("f")).mode & 0o777);
  step("access F 000", () => fs.accessSync(at("f")));
  step("access R 000", () => fs.accessSync(at("f"), fs.constants.R_OK));
  step("chmod as owner", () => fs.chmodSync(at("f"), 0));
  step("utimes as owner", () => fs.utimesSync(at("f"), 1, 1));
  mode(at("f"), 0o444);
  step("write 444", () => fs.writeFileSync(at("f"), "x"));
  step("append 444", () => fs.appendFileSync(at("f"), "x"));
  step("truncate 444", () => fs.truncateSync(at("f"), 0));
  step("open r+ 444", () => fs.openSync(at("f"), "r+"));
  step("open trunc 444", () => fs.openSync(at("f"), fs.constants.O_RDONLY | fs.constants.O_TRUNC));
  step("open creat 444", () =>
    fs.closeSync(fs.openSync(at("f"), fs.constants.O_RDONLY | fs.constants.O_CREAT)),
  );
  step("open wx 444", () => fs.openSync(at("f"), "wx"));
  step("access W 444", () => fs.accessSync(at("f"), fs.constants.W_OK));
  step("access X 444", () => fs.accessSync(at("f"), fs.constants.X_OK));
  step("copy from 444", () => fs.copyFileSync(at("f"), at("copy")));
  changed.add(at("copy"));
  step("copy keeps mode", () => fs.statSync(at("copy")).mode & 0o777);
  step("copy onto 444", () => fs.copyFileSync(at("copy"), at("f")));
  step("read 444", () => fs.readFileSync(at("f"), "utf8"));
  mode(at("f"), 0o222);
  step("read 222", () => fs.readFileSync(at("f"), "utf8"));
  step("write 222", () => fs.writeFileSync(at("f"), "new"));
  step("truncate 222", () => fs.truncateSync(at("f"), 0));
  step("copy from 222", () => fs.copyFileSync(at("f"), at("copy2")));
  const fd = fs.openSync(at("f"), "w");
  mode(at("f"), 0);
  step("an open fd keeps working", () => fs.writeSync(fd, "kept"));
  fs.closeSync(fd);
  mode(at("f"), 0o200);
  step("watch 200", () => fs.watch(at("f")).close());
  mode(at("f"), 0o644);

  // A directory without write.
  fs.mkdirSync(at("ro/sub"), { recursive: true });
  fs.writeFileSync(at("ro/sub/deep"), "deep");
  fs.writeFileSync(at("ro/in"), "in");
  fs.writeFileSync(at("out"), "out");
  mode(at("ro"), 0o555);
  step("create in 555", () => fs.writeFileSync(at("ro/new"), "x"));
  step("write existing in 555", () => fs.writeFileSync(at("ro/in"), "in2"));
  step("open w existing in 555", () => fs.closeSync(fs.openSync(at("ro/in"), "w")));
  step("mkdir in 555", () => fs.mkdirSync(at("ro/m")));
  step("mkdir existing in 555", () => fs.mkdirSync(at("ro/sub")));
  step("mkdir -p existing in 555", () => fs.mkdirSync(at("ro/sub"), { recursive: true }));
  step("mkdir -p new in 555", () => fs.mkdirSync(at("ro/m/n"), { recursive: true }));
  step("unlink in 555", () => fs.unlinkSync(at("ro/in")));
  step("unlink missing in 555", () => fs.unlinkSync(at("ro/nope")));
  step("rmdir nonempty in 555", () => fs.rmdirSync(at("ro/sub")));
  step("rename in 555", () => fs.renameSync(at("ro/in"), at("ro/in2")));
  step("rename out of 555", () => fs.renameSync(at("ro/in"), at("moved")));
  step("rename into 555", () => fs.renameSync(at("out"), at("ro/out")));
  step("symlink in 555", () => fs.symlinkSync("in", at("ro/link")));
  step("link in 555", () => fs.linkSync(at("out"), at("ro/hard")));
  step("open wx in 555", () => fs.openSync(at("ro/n2"), "wx"));
  step("mkdtemp in 555", () => fs.mkdtempSync(at("ro/t-")));
  step("copy into 555", () => fs.copyFileSync(at("out"), at("ro/c")));
  step("rmSync file in 555", () => fs.rmSync(at("ro/in")));
  step("rmSync -f missing in 555", () => fs.rmSync(at("ro/missing"), { force: true }));
  step("rmSync -r empties, then refused", () => fs.rmSync(at("ro/sub"), { recursive: true }));
  step("what rmSync left", () => fs.readdirSync(at("ro/sub")));
  // What comes before the refusal goes. Only what is left is compared: Linux
  // says EACCES, macOS ENOTEMPTY, and either may leave more when the refused
  // entry is not the last one met.
  fs.mkdirSync(at("rt/a"), { recursive: true });
  fs.mkdirSync(at("rt/z"));
  fs.writeFileSync(at("rt/a/f"), "a");
  fs.writeFileSync(at("rt/b"), "b");
  fs.writeFileSync(at("rt/z/f"), "z");
  mode(at("rt/z"), 0o555);
  try {
    fs.rmSync(at("rt"), { recursive: true });
  } catch {
    // Compared below.
  }
  step("rmSync -r up to a refusal leaves", () => [
    fs.readdirSync(at("rt")),
    fs.readdirSync(at("rt/z")),
  ]);
  step("access W 555", () => fs.accessSync(at("ro"), fs.constants.W_OK));
  step("readdir 555", () => fs.readdirSync(at("ro")).sort());
  await stepAsync("promises.rm in 555", () => fs.promises.rm(at("ro/in")));
  await stepAsync("promises.readFile 000", async () => {
    mode(at("ro/in"), 0);
    try {
      return await fs.promises.readFile(at("ro/in"), "utf8");
    } finally {
      fs.chmodSync(at("ro/in"), 0o644);
    }
  });

  // A directory without search: listed, but nothing in it can be reached.
  fs.mkdirSync(at("nx/sub"), { recursive: true });
  fs.writeFileSync(at("nx/in"), "in");
  fs.symlinkSync("nx/in", at("via"));
  mode(at("nx"), 0o644);
  step("stat nx", () => fs.statSync(at("nx")).mode & 0o777);
  step("stat nx/", () => fs.statSync(at("nx") + "/").mode & 0o777);
  step("stat in nx", () => fs.statSync(at("nx/in")));
  step("lstat in nx", () => fs.lstatSync(at("nx/in")));
  step("stat nx/.", () => fs.statSync(at("nx") + "/."));
  step("stat nx/..", () => fs.statSync(at("nx") + "/.."));
  step("stat through a link", () => fs.statSync(at("via")));
  step("lstat the link", () => fs.lstatSync(at("via")).isSymbolicLink());
  step("exists in nx", () => fs.existsSync(at("nx/in")));
  step("readdir nx", () => fs.readdirSync(at("nx")).sort());
  step("read in nx", () => fs.readFileSync(at("nx/in"), "utf8"));
  step("access X nx", () => fs.accessSync(at("nx"), fs.constants.X_OK));
  step("chmod in nx", () => fs.chmodSync(at("nx/in"), 0o600));
  step("readlink in nx", () => fs.readlinkSync(at("nx/in")));
  step("realpath in nx", () => fs.realpathSync(at("nx/in")));
  step("realpath.native in nx", () => fs.realpathSync.native(at("nx/in")));
  step("open nx", () => fs.closeSync(fs.openSync(at("nx"), "r")));
  step("create in nx", () => fs.writeFileSync(at("nx/new"), "x"));

  // A directory without read: reached through, but not listed.
  fs.mkdirSync(at("nr"));
  fs.writeFileSync(at("nr/in"), "in");
  mode(at("nr"), 0o311);
  step("readdir nr", () => fs.readdirSync(at("nr")));
  step("stat in nr", () => fs.statSync(at("nr/in")).size);
  step("read in nr", () => fs.readFileSync(at("nr/in"), "utf8"));
  step("create in nr", () => fs.writeFileSync(at("nr/new"), "x"));
  step("open nr", () => fs.closeSync(fs.openSync(at("nr"), "r")));
  step("rmSync -r nr", () => fs.rmSync(at("nr"), { recursive: true }));

  // An empty directory with no permissions at all.
  fs.mkdirSync(at("z"));
  mode(at("z"), 0);
  step("stat 000 dir", () => fs.statSync(at("z")).mode & 0o777);
  step("rmdir 000 dir", () => fs.rmdirSync(at("z")));

  // A directory moved to another directory changes its `..`: it needs write.
  fs.mkdirSync(at("a/mv"), { recursive: true });
  fs.mkdirSync(at("b"));
  mode(at("a/mv"), 0o555);
  step("move 555 dir away", () => fs.renameSync(at("a/mv"), at("b/mv")));
  step("rename 555 dir in place", () => fs.renameSync(at("a/mv"), at("a/mv2")));
  changed.add(at("a/mv2"));

  // Running a file needs its execute bit; an interpreter given it, only read.
  fs.writeFileSync(at("s.sh"), "#!/bin/sh\necho ran\n");
  fs.writeFileSync(at("s.js"), "console.log('js ran')\n");
  fs.mkdirSync(at("bin"));
  fs.writeFileSync(at("bin/tool"), "#!/bin/sh\necho tool\n");
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
    return result.error
      ? { error: result.error.code, syscall: result.error.syscall }
      : { status: result.status, out: result.stdout, err: show(result.stderr) };
  };
  step("spawn ./s.sh", () => run("./s.sh", []));
  step("spawn ./s.js", () => run("./s.js", []));
  step("spawn a directory", () => run("./bin", []));
  step("sh ./s.sh", () => run("sh", ["-c", "./s.sh; echo status=$?"]));
  step("sh s.sh", () => run("sh", ["-c", "sh s.sh; echo status=$?"]));
  step("node s.js", () => run("node", ["s.js"]));
  step("found on PATH but not executable", () => run("tool", [], { env: { PATH: at("bin") } }));
  mode(at("s.sh"), 0o755);
  mode(at("bin/tool"), 0o700);
  step("spawn ./s.sh +x", () => run("./s.sh", []));
  step("found on PATH +x", () => run("tool", [], { env: { PATH: at("bin") } }));
  mode(at("s.js"), 0o200);
  const unreadable = run("node", ["s.js"]);
  step("node on an unreadable file", () => [
    unreadable.status,
    /EACCES: permission denied, open '[^']*s\.js'/.test(unreadable.err),
  ]);
  mode(at("bin"), 0o644);
  step("spawn in a directory it cannot enter", () => run("node", ["-v"], { cwd: at("bin") }));
  // A shell's command stays where the shell is: nothing changes into it.
  fs.mkdirSync(at("stay"));
  changed.add(at("stay"));
  step("a command where the shell cannot search", () =>
    run("sh", ["-c", "cd stay && chmod 600 . && node -e \"console.log('ran')\"; echo s=$?"]),
  );

  // chdir needs search on the directory, as chdir(2) does.
  fs.mkdirSync(at("cd-nx"));
  mode(at("cd-nx"), 0o600);
  step("chdir into 600", () => process.chdir(at("cd-nx")));
  step("cwd after a refused chdir", () => show(process.cwd()));
  // A child given no cwd stays where its parent is, even where it could not
  // change into; one given that cwd is refused.
  fs.mkdirSync(at("cd-in"));
  const home = process.cwd();
  const children = [];
  process.chdir(at("cd-in"));
  try {
    mode(at("cd-in"), 0o600);
    for (const options of [{}, { cwd: at("cd-in") }]) {
      const result = spawnSync("node", ["-e", "console.log('child ran')"], {
        encoding: "utf8",
        ...options,
      });
      children.push(
        result.error
          ? [result.error.code, result.error.syscall]
          : [result.status, result.stdout.trim()],
      );
    }
  } finally {
    process.chdir(home);
  }
  step("spawnSync from a cwd it cannot search, no cwd option", () => children[0]);
  step("spawnSync with that cwd given", () => children[1]);

  // What a refusal names, form by form: opendirSync names no path, the
  // callback and promise forms the directory; fs.rm and fs.promises.rm ask
  // what is there (lstat) before anything, whatever their options.
  fs.mkdirSync(at("od"));
  fs.writeFileSync(at("od/in"), "in");
  mode(at("od"), 0o311);
  step("opendirSync 311", () => fs.opendirSync(at("od")).closeSync());
  await stepAsync(
    "opendir 311",
    () =>
      new Promise((resolve, reject) =>
        fs.opendir(at("od"), (error, dir) => (error ? reject(error) : resolve(dir.closeSync()))),
      ),
  );
  await stepAsync("promises.opendir 311", () =>
    fs.promises.opendir(at("od")).then((dir) => dir.close()),
  );
  await stepAsync("promises.opendir missing", () => fs.promises.opendir(at("od-none")));
  mode(at("od"), 0o644);
  await stepAsync("promises.rm -rf in 644", () =>
    fs.promises.rm(at("od/none"), { recursive: true, force: true }),
  );
  await stepAsync(
    "rm -rf in 644",
    () =>
      new Promise((resolve, reject) =>
        fs.rm(at("od/in"), { recursive: true, force: true }, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
  );
  step("rmSync -rf in 644", () => fs.rmSync(at("od/none"), { recursive: true, force: true }));
  mode(at("od"), 0o755);

  // A directory cannot replace one it is in, whoever may write where. (The
  // code only: ENOTEMPTY has another number on macOS.)
  fs.mkdirSync(at("up/q/r"), { recursive: true });
  mode(at("up"), 0o555);
  step("rename onto the directory it is in, below 555", () => {
    try {
      fs.renameSync(at("up/q/r"), at("up/q"));
      return "renamed";
    } catch (error) {
      return [error.code, error.syscall];
    }
  });
  mode(at("up"), 0o755);

  // `name/.` walks through `name`: nothing is made there when it is missing.
  // (Spelled out: path.join would drop the dot.)
  const dot = at("dot");
  fs.mkdirSync(dot);
  step("mkdir missing/.", () => fs.mkdirSync(`${dot}/n1/.`));
  step("mkdir missing/", () => fs.mkdirSync(`${dot}/n2/`));
  step("open wx missing/.", () => fs.closeSync(fs.openSync(`${dot}/n3/.`, "wx")));
  step("rename to missing/.", () => fs.renameSync(`${dot}/n2`, `${dot}/n4/.`));
  step("mkdir -p through ./", () => show(fs.mkdirSync(`${dot}/p1/./p2`, { recursive: true })));
  step("mkdir -p several", () => show(fs.mkdirSync(`${dot}/m1/m2/m3`, { recursive: true })));
  step("mkdir -p again", () => fs.mkdirSync(`${dot}/m1/m2/m3`, { recursive: true }));
  step("after the dots", () => fs.readdirSync(dot).sort());

  // A device's mode decides, as a file's does.
  step("access R|W /dev/null", () =>
    fs.accessSync("/dev/null", fs.constants.R_OK | fs.constants.W_OK),
  );
  step("access X /dev/null", () => fs.accessSync("/dev/null", fs.constants.X_OK));

  step("/tmp", () => (fs.statSync("/tmp").mode & 0o7777).toString(8));
}

main()
  .catch((error) => console.log("case failed:", error))
  .finally(restore);
