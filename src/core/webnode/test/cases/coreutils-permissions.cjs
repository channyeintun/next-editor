// Refusals and special bits as the tools around a program report them:
// `ls -l` shows setuid and sticky bits (s/S, t/T), a `#!` script gets the path
// it was run by as `$0`, an asynchronous `mkdir -p` names the directory it
// failed to make, and the module loader names a package.json it may not read.
// A command's operand is the path as it is written: an empty one names
// nothing, `..` leaves a linked directory through the directory the link
// points into, a directory the path goes through must be searchable, and a
// trailing slash asks for a directory. `cp` leaves an existing destination
// its mode.
// Only what macOS's tools print the same way is here: setgid needs a group the
// user is in, and BSD's tools word their errors differently from GNU's (those
// are in the unit tests), so the operand steps show statuses and what is left.
// Every mode is given back at the end.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(process.cwd(), "cu-case");
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
    console.log(label, error.code, show(error.message).split("\n")[0]);
  }
}

async function stepAsync(label, run) {
  try {
    const value = await run();
    console.log(label, "ok", value === undefined ? "" : JSON.stringify(show(value)));
  } catch (error) {
    console.log(label, error.code, error.syscall, show(error.message).split("\n")[0]);
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

/** A child's status and output, with the shell's own name dropped from its errors. */
function ran(command, args, options) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  const stderr = result.stderr.replace(/^[^:\n]*: /gm, "");
  return { status: result.status, stdout: result.stdout, stderr };
}

async function main() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  const at = (name) => path.join(root, name);

  // ls -l: setuid over the user's x, sticky over the other's x.
  for (const bits of [0o4755, 0o4644, 0o1755, 0o1754]) {
    const name = `d${bits.toString(8)}`;
    fs.mkdirSync(at(name));
    mode(at(name), bits);
  }
  step("ls modes", () => ran("sh", ["-c", "ls -ld d* /tmp/ | cut -c1-10"]).stdout);

  // A #! script's $0 is the path it was run by; so is what a refusal names.
  fs.mkdirSync(at("bin"));
  fs.writeFileSync(at("x.sh"), '#!/bin/sh\necho "$0"\n');
  fs.writeFileSync(at("bin/tool"), '#!/bin/sh\necho "$0"\n');
  fs.writeFileSync(at("xo.sh"), "#!/bin/sh\necho ran\n");
  mode(at("x.sh"), 0o755);
  mode(at("bin/tool"), 0o755);
  mode(at("xo.sh"), 0o100);
  step("./x.sh", () => ran("./x.sh", []));
  step("PATH=bin tool", () =>
    ran("tool", [], { env: { ...process.env, PATH: `bin:${process.env.PATH}` } }),
  );
  step("./xo.sh (x only)", () => ran("./xo.sh", []));

  // An empty operand (an unset variable in quotes) names nothing.
  fs.mkdirSync(at("op/proj/src"), { recursive: true });
  fs.writeFileSync(at("op/proj/src/index.js"), "");
  fs.writeFileSync(at("op/proj/package.json"), "{}");
  const sh = (script) => ran("sh", ["-c", script]).stdout;
  step('rm -rf ""', () => sh('cd op/proj && rm -rf "$UNSET"; echo "status $?"; ls -A . src'));
  step("other commands on an empty operand", () =>
    sh(
      [
        "cd op/proj",
        'rm -r "" 2>/dev/null; echo "rm -r $?"',
        'chmod -R a-w "" 2>/dev/null; echo "chmod -R $?"',
        'mv "" ../moved 2>/dev/null; echo "mv $?"',
        'cp -r "" ../copied 2>/dev/null; echo "cp -r $?"',
        'find "" -name "*.js" -delete 2>/dev/null; echo "find $?"',
        'cat "" 2>/dev/null; echo "cat $?"',
        '[ -d "" ]; echo "test -d $?"',
        "ls -ld . src/index.js | cut -c1-10",
        "ls -A . ..",
      ].join("; "),
    ),
  );

  // `..` after a link, and through a directory that may not be searched.
  fs.mkdirSync(at("op/dd/d/sub"), { recursive: true });
  fs.symlinkSync("d/sub", at("op/dd/link"));
  fs.writeFileSync(at("op/dd/x"), "outer\n");
  fs.writeFileSync(at("op/dd/d/x"), "inner\n");
  step(".. after a link", () =>
    sh(
      [
        "cd op/dd",
        "cat link/../x",
        "[ -d link/../sub ] && echo dir",
        "ls link/..",
        "cp link/../x copied; cat copied",
        "(cd link; cat ../x)",
        "rm -f link/../x; ls x d/x 2>/dev/null",
      ].join("; "),
    ),
  );
  fs.mkdirSync(at("op/nx/sub"), { recursive: true });
  fs.writeFileSync(at("op/f"), "hi\n");
  mode(at("op/nx"), 0o000);
  step(".. out of a directory without search", () =>
    sh(
      [
        "cd op",
        'cat nx/../f 2>/dev/null; echo "cat $?"',
        '[ -f nx/../f ]; echo "test $?"',
        'cp nx/../f g 2>/dev/null; echo "cp $?"',
        'rm -f nx/../f 2>/dev/null; echo "rm $?"',
        "ls",
      ].join("; "),
    ),
  );

  // A trailing slash asks for a directory.
  fs.mkdirSync(at("op/ts/real/in"), { recursive: true });
  fs.symlinkSync("real", at("op/ts/link"));
  fs.writeFileSync(at("op/ts/plain"), "p\n");
  step("trailing slashes", () =>
    sh(
      [
        "cd op/ts",
        'rm link/ 2>/dev/null; echo "rm link/ $?"',
        'cp plain nodir/ 2>/dev/null; echo "cp nodir/ $?"',
        'mv plain nodir/ 2>/dev/null; echo "mv nodir/ $?"',
        'cat plain/ 2>/dev/null; echo "cat plain/ $?"',
        "ls -A . real",
      ].join("; "),
    ),
  );

  // cp writes into a destination that is there and leaves its mode.
  fs.writeFileSync(at("op/r"), "ro\n");
  fs.writeFileSync(at("op/w"), "w\n");
  mode(at("op/r"), 0o444);
  step("cp onto an existing file", () =>
    sh(
      'cd op && cp r w; echo "cp $?"; ls -l w | cut -c1-10; echo more >> w; echo "append $?"; cat w; ' +
        "cp r newr; ls -l newr | cut -c1-10; chmod 644 newr",
    ),
  );

  // sort takes a file of any length; yes ends when its reader does.
  fs.writeFileSync(
    at("op/big.txt"),
    `${Array.from({ length: 200000 }, (_, index) => `${index + 1} line`).join("\n")}\n`,
  );
  step("sort a long file", () =>
    sh(
      'cd op && sort -n big.txt | tail -n 1; sort -rn big.txt > sorted; echo "sort $?"; head -n 1 sorted',
    ),
  );
  step("yes", () => sh('yes | head -n 2; yes ok | head -n 1; echo "status $?"'));

  // mkdir -p in its async forms names the directory it failed to make.
  fs.mkdirSync(at("mk/ro"), { recursive: true });
  fs.mkdirSync(at("mk/p"));
  fs.symlinkSync("missing", at("mk/l"));
  mode(at("mk/ro"), 0o555);
  process.chdir(root);
  for (const [target, options] of [
    ["mk/ro/a/b", { recursive: true }],
    ["mk/ro/a/b/", { recursive: true }],
    ["mk/p/a/b/c", { recursive: true, mode: 0o555 }],
    ["mk/l/a", { recursive: true }],
    ["mk/p/q/r/", { recursive: true }],
  ]) {
    await stepAsync(
      `mkdir ${target} (callback)`,
      () =>
        new Promise((resolve, reject) =>
          fs.mkdir(target, options, (error, first) => (error ? reject(error) : resolve(first))),
        ),
    );
    await stepAsync(`mkdir ${target} (promises)`, () => fs.promises.mkdir(target, options));
    step(`mkdir ${target} (sync)`, () => fs.mkdirSync(target, options));
  }
  changed.add(at("mk/p/a"));
  changed.add(at("mk/p/a/b"));
  process.chdir(path.dirname(root));

  // A package.json the loader may not read, or whose directory it may not search.
  fs.mkdirSync(at("pkg/mdir"), { recursive: true });
  fs.writeFileSync(at("pkg/mdir/package.json"), '{"main":"x.js"}');
  fs.writeFileSync(at("pkg/mdir/x.js"), "module.exports = 1;");
  fs.mkdirSync(at("pkg/node_modules/p"), { recursive: true });
  fs.writeFileSync(at("pkg/node_modules/p/package.json"), '{"main":"i.js"}');
  fs.writeFileSync(at("pkg/node_modules/p/i.js"), "module.exports = 2;");
  fs.writeFileSync(at("pkg/main.js"), "");
  mode(at("pkg/mdir"), 0o600);
  mode(at("pkg/node_modules/p/package.json"), 0o200);
  const local = require("module").createRequire(at("pkg/main.js"));
  step("require a directory it may not search", () => local("./mdir"));
  step("require a package.json it may not read", () => local("p"));
  await stepAsync("import a package.json it may not read", () =>
    import(at("pkg/node_modules/p/i.js")).then((m) => m.default),
  );
}

main()
  .catch((error) => console.log("case failed", show(error.stack)))
  .finally(restore);
