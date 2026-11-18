// fs.readdir with `recursive`, in its three forms: the names it returns, each
// Dirent's parentPath, and the path an error names for a directory below the
// start that cannot be read, which is the start as spelled with the names
// below it appended ('./a/nr', 'a/../nr', 'a//nr').
"use strict";
const fs = require("fs");
const fsp = fs.promises;

const sync = (p, options) => {
  try {
    return fs.readdirSync(p, options);
  } catch (error) {
    return error;
  }
};
const promised = (p, options) => fsp.readdir(p, options).catch((error) => error);
const called = (p, options) =>
  new Promise((resolve) => fs.readdir(p, options, (error, list) => resolve(error ?? list)));

(async () => {
  fs.mkdirSync("rt/a/b/c", { recursive: true });
  fs.writeFileSync("rt/a/f", "");
  fs.writeFileSync("rt/a/b/g", "");
  fs.symlinkSync("b", "rt/a/lb");
  process.chdir("rt");
  const abs = process.cwd();
  const hide = (text) => String(text).split(abs).join("<abs>");
  const show = (result) =>
    result instanceof Error
      ? `${result.code} ${result.syscall} ${hide(result.path)}`
      : result
          .map((entry) =>
            typeof entry === "string" || Buffer.isBuffer(entry)
              ? String(entry)
              : `${hide(entry.parentPath)}|${entry.name}|${"path" in entry}`,
          )
          .sort()
          .join(" ");
  const all = async (p, options) => {
    const answers = [
      show(sync(p, options)),
      show(await promised(p, options)),
      show(await called(p, options)),
    ];
    return answers[1] === answers[0] && answers[2] === answers[0]
      ? answers[0]
      : answers.join(" / ");
  };

  const starts = [
    ".",
    "./",
    "a",
    "a/",
    "a//",
    "./a",
    "a/b/..",
    "a/lb",
    "a/lb/",
    `${abs}/a`,
    `${abs}/a/`,
  ];
  for (const p of starts) {
    console.log(hide(p), "names:", await all(p, { recursive: true }));
    console.log(hide(p), "buffers:", await all(p, { recursive: true, encoding: "buffer" }));
    console.log(hide(p), "dirents:", await all(p, { recursive: true, withFileTypes: true }));
  }

  // No link below: the callback form walks in an order of its own, and would
  // meet a locked directory by another name first.
  fs.unlinkSync("a/lb");
  fs.mkdirSync("a/b/nr3/in", { recursive: true });
  fs.mkdirSync("a/nr2/in", { recursive: true });
  fs.mkdirSync("nr1/in", { recursive: true });
  const locked = [
    ["nr1", [".", "./", "./.", ".//", "a/..", "a/../", abs, `${abs}/`]],
    ["a/nr2", [".", "./", "a", "a/", "./a", "a//", "a/b/..", abs, `${abs}/./`]],
    ["a/b/nr3", [".", "./", "a", "./a/", "a/b", "a/b/", `${abs}//a`, "a/b/../b"]],
  ];
  for (const [dir, from] of locked) {
    fs.chmodSync(dir, 0o311);
    for (const p of from) {
      const names = await all(p, { recursive: true });
      const dirents = await all(p, { recursive: true, withFileTypes: true });
      console.log(`${dir} from ${hide(p)}:`, names, "|", dirents);
    }
    fs.chmodSync(dir, 0o755);
  }
  // The start itself unreadable: named as given.
  fs.chmodSync("a", 0o311);
  console.log(
    "a itself:",
    await all("a/", { recursive: true }),
    "|",
    await all("./a", { recursive: true, withFileTypes: true }),
  );
  fs.chmodSync("a", 0o755);
  process.chdir("..");
  fs.rmSync("rt", { recursive: true, force: true });
})();
