// The file mode creation mask: process.umask() reads it and sets it, every
// file and directory the process creates afterwards gets its mode less the
// mask, a child starts with a copy, and a worker thread shares the process's
// (it may read the mask, not set it). Masks stay within the permission bits
// and links are left out: macOS and Linux differ there.
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const { Worker } = require("worker_threads");

const root = path.join(process.cwd(), "umask-case");
const at = (name) => path.join(root, name);
const perm = (name) => (fs.lstatSync(at(name)).mode & 0o777).toString(8).padStart(3, "0");
const show = (text) => String(text).split(process.cwd()).join("<cwd>");

function step(label, run) {
  try {
    const value = run();
    console.log(label, value === undefined ? "ok" : value);
  } catch (error) {
    console.log(label, error.code, error.name, show(error.message));
  }
}

/** Removes the case's directory, whatever modes the masks left in it. */
function cleanUp() {
  process.umask(0o022);
  const open = (dir) => {
    fs.chmodSync(dir, 0o755);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        open(path.join(dir, entry.name));
      }
    }
  };
  open(root);
  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  process.umask(0o022);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);

  step("set 077 returns", () => process.umask(0o077).toString(8));
  step("reads", () => process.umask().toString(8));
  fs.writeFileSync(at("w"), "x");
  fs.writeFileSync(at("w666"), "x", { mode: 0o666 });
  fs.writeFileSync(at("w777"), "x", { mode: 0o777 });
  fs.closeSync(fs.openSync(at("o"), "w"));
  fs.closeSync(fs.openSync(at("o777"), "w", 0o777));
  fs.appendFileSync(at("a"), "x");
  console.log("files", perm("w"), perm("w666"), perm("w777"), perm("o"), perm("o777"), perm("a"));
  fs.mkdirSync(at("d"));
  fs.mkdirSync(at("d777"), 0o777);
  console.log("mkdirSync", perm("d"), perm("d777"));
  step("mkdirSync recursive", () =>
    path.relative(root, fs.mkdirSync(at("r/s/t"), { recursive: true })),
  );
  console.log("recursive", perm("r"), perm("r/s"), perm("r/s/t"));
  fs.mkdirSync(at("q/s"), { recursive: true, mode: 0o755 });
  console.log("recursive 755", perm("q"), perm("q/s"));
  console.log("mkdtempSync", perm(path.relative(root, fs.mkdtempSync(at("t-")))));

  // A copy has its source's mode, whatever the mask: libuv sets it with fchmod.
  fs.chmodSync(at("w777"), 0o777);
  fs.copyFileSync(at("w777"), at("c777"));
  fs.chmodSync(at("w"), 0o640);
  fs.copyFileSync(at("w"), at("c640"));
  fs.writeFileSync(at("there"), "x");
  fs.chmodSync(at("there"), 0o666);
  fs.copyFileSync(at("w777"), at("there"));
  console.log("copyFileSync", perm("c777"), perm("c640"), perm("there"));
  fs.mkdirSync(at("src/in"), { recursive: true });
  fs.writeFileSync(at("src/in/f"), "x");
  fs.chmodSync(at("src/in/f"), 0o666);
  fs.chmodSync(at("src/in"), 0o777);
  fs.chmodSync(at("src"), 0o777);
  fs.cpSync(at("w777"), at("cp777"));
  fs.cpSync(at("src"), at("dst"), { recursive: true });
  console.log("cpSync", perm("cp777"), perm("dst"), perm("dst/in"), perm("dst/in/f"));

  // What is there already keeps its mode.
  fs.writeFileSync(at("there"), "again");
  fs.mkdirSync(at("src"), { recursive: true });
  console.log("existing", perm("there"), perm("src"));

  await new Promise((resolve) => fs.createWriteStream(at("ws")).end("x", resolve));
  await fs.promises.writeFile(at("pw"), "x");
  await fs.promises.mkdir(at("pd"));
  await (await fs.promises.open(at("po"), "w")).close();
  await new Promise((resolve) => fs.writeFile(at("cw"), "x", resolve));
  await new Promise((resolve) => fs.mkdir(at("cd"), resolve));
  console.log("async", perm("ws"), perm("pw"), perm("pd"), perm("po"), perm("cw"), perm("cd"));

  step("mask 0", () => {
    process.umask(0);
    fs.writeFileSync(at("z"), "");
    fs.mkdirSync(at("zd"));
    return `${perm("z")} ${perm("zd")}`;
  });
  step("mask 277", () => {
    const before = process.umask(0o277).toString(8);
    const made = path.relative(root, fs.mkdtempSync(at("u-")));
    fs.writeFileSync(at("u"), "");
    return `${before} ${perm(made)} ${perm("u")}`;
  });
  step("mask 777", () => {
    const before = process.umask(0o777).toString(8);
    fs.writeFileSync(at("n"), "kept");
    fs.mkdirSync(at("nd"));
    return `${before} ${perm("n")} ${perm("nd")}`;
  });
  // A new file is not checked against its own mode, only afterwards.
  step("read 000", () => fs.readFileSync(at("n"), "utf8"));
  step("string 027", () => `${process.umask("027").toString(8)} ${process.umask().toString(8)}`);
  for (const bad of ["0o27", "89", "", -1, 1.5, NaN, 2 ** 32, null, true, {}, []]) {
    step(`bad ${typeof bad} ${String(bad)}`, () => process.umask(bad));
  }
  step("after the bad ones", () => process.umask(undefined).toString(8));
  console.log("function", process.umask.length, process.umask.name);

  // A child starts with a copy of the mask and changes only its own.
  const script =
    "const fs = require('fs');" +
    "const perm = (name) => (fs.statSync(name).mode & 0o777).toString(8);" +
    "console.log('child reads', process.umask().toString(8));" +
    "fs.writeFileSync('cf', ''); fs.mkdirSync('cdir');" +
    "console.log('child made', perm('cf'), perm('cdir'));" +
    "process.umask(0); fs.writeFileSync('cf0', '');" +
    "console.log('child set', process.umask().toString(8), perm('cf0'));";
  process.stdout.write(
    execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" }),
  );
  console.log("parent after the child", process.umask().toString(8));
  // So does a shell, and what the shell starts.
  const shell =
    "umask; : > sf; mkdir sd; (umask 077; : > sub; umask); umask; " +
    `"${process.execPath}" -e "console.log('under the shell', process.umask().toString(8))"; ` +
    `(umask 002; "${process.execPath}" -e "console.log('under its subshell', process.umask().toString(8))")`;
  process.stdout.write(execSync(shell, { cwd: root, encoding: "utf8" }));
  console.log("shell made", perm("sf"), perm("sd"), perm("sub"));

  // A worker thread reads the process's mask and creates under it, but may not set it.
  const worker = new Worker(
    `const fs = require('fs');
     const { parentPort, workerData } = require('worker_threads');
     const perm = (name) => (fs.statSync(workerData + '/' + name).mode & 0o777).toString(8);
     const lines = ['thread reads ' + process.umask().toString(8)];
     for (const mask of [0o077, 'zz', undefined]) {
       try {
         lines.push('thread umask(' + String(mask) + ') ' + process.umask(mask).toString(8));
       } catch (error) {
         lines.push('thread umask(' + String(mask) + ') ' + error.code + ' ' + error.name + ' ' + error.message);
       }
     }
     fs.writeFileSync(workerData + '/tf', '');
     fs.mkdirSync(workerData + '/td');
     lines.push('thread made ' + perm('tf') + ' ' + perm('td'));
     parentPort.once('message', () => {
       lines.push('thread reads after the main thread set it ' + process.umask().toString(8));
       fs.writeFileSync(workerData + '/tf2', '');
       lines.push('thread made ' + perm('tf2'));
       parentPort.postMessage(lines);
     });
     parentPort.postMessage('ready');`,
    { eval: true, workerData: root },
  );
  const lines = await new Promise((resolve) => {
    worker.on("message", (message) => {
      if (message === "ready") {
        process.umask(0o002);
        worker.postMessage("go");
      } else {
        resolve(message);
      }
    });
  });
  for (const line of lines) {
    console.log(line);
  }
  await worker.terminate();
  console.log("main thread made", perm("tf"), perm("td"), perm("tf2"));
}

main()
  .catch((error) => console.log("failed", error))
  .finally(cleanUp);
