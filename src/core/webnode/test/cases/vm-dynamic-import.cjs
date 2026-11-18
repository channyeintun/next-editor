// import() in code that vm compiles is the one its importModuleDynamically
// option asks for: without the option it rejects at once, the main context's
// default loader loads from the file the code is named after (the working
// directory for a name that is not absolute), and a function is called only
// behind --experimental-vm-modules, so it rejects too.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = path.join(process.cwd(), "tmp-vm-dynamic-import");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
fs.writeFileSync(path.join(dir, "x.mjs"), 'export const where = "top";');
fs.writeFileSync(path.join(dir, "lib/x.mjs"), 'export const where = "lib";');
process.chdir(dir);
process.emitWarning = (message, type) => console.log("warning:", type, message);

const L = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
let called = 0;
const callback = () => {
  called += 1;
  return import("./x.mjs");
};
const show = async (label, promise) => {
  try {
    const m = await promise;
    console.log(label, "->", m.where);
  } catch (e) {
    console.log(label, "->", e.name, e.code, String(e.message).split("\n")[0]);
  }
};

(async () => {
  await show("runInThisContext", vm.runInThisContext("import('./x.mjs')"));
  await show("Script", new vm.Script("import('./x.mjs')").runInThisContext());
  await show("compileFunction", vm.compileFunction("return import('./x.mjs')")());
  await show("runInNewContext", vm.runInNewContext("import('./x.mjs')", {}));
  await show("runInContext", vm.runInContext("import('./x.mjs')", vm.createContext({})));
  await show("direct eval inside", vm.runInThisContext("eval(\"import('./x.mjs')\")"));
  await show("builtin", vm.runInThisContext("import('node:path')"));
  await show("loader", vm.runInThisContext("import('./x.mjs')", { importModuleDynamically: L }));
  await show(
    "loader, file in lib",
    vm.runInThisContext("import('./x.mjs')", {
      filename: path.join(dir, "lib/f.js"),
      importModuleDynamically: L,
    }),
  );
  await show(
    "loader, relative file",
    vm.runInThisContext("import('./x.mjs')", { filename: "lib/f.js", importModuleDynamically: L }),
  );
  await show(
    "loader Script",
    new vm.Script("import('./x.mjs')", { importModuleDynamically: L }).runInThisContext(),
  );
  await show(
    "loader compileFunction",
    vm.compileFunction("return import('./x.mjs')", [], { importModuleDynamically: L })(),
  );
  await show(
    "loader context",
    vm.runInNewContext("import('./x.mjs')", {}, { importModuleDynamically: L }),
  );
  await show(
    "loader eval inside",
    vm.runInThisContext("eval(\"import('./x.mjs')\")", { importModuleDynamically: L }),
  );
  await show(
    "option on run",
    new vm.Script("import('./x.mjs')").runInThisContext({ importModuleDynamically: L }),
  );
  await show(
    "callback",
    vm.runInThisContext("import('./x.mjs')", { importModuleDynamically: callback }),
  );
  await show(
    "callback compileFunction",
    vm.compileFunction("return import('./x.mjs')", [], { importModuleDynamically: callback })(),
  );
  console.log("callback called", called);
  for (const bad of [5, null, Symbol("x")]) {
    try {
      vm.runInThisContext("1", { importModuleDynamically: bad });
    } catch (e) {
      console.log(e.code, e.message);
    }
  }
  // The last work of the program: the rejection still arrives.
  vm.runInThisContext("import('./x.mjs')").catch((e) => {
    console.log("last", e.code);
    process.chdir("..");
    fs.rmSync(dir, { recursive: true, force: true });
  });
})();
