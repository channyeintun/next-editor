// Export names that are strings (`export { a as "any string" }`): read by an
// importer, through the namespace and through a re-export, and the
// "module.exports" name, which says what require() of an ES module returns.
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "tmp-export-names");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const files = {
  "strings.mjs":
    "const a = 1; const b = 2; export { a as 'kebab-name', b as \"with space\", a as plain };",
  "reads-strings.mjs":
    "import { 'kebab-name' as kebab, \"with space\" as spaced, plain } from './strings.mjs'; export const sum = kebab + spaced + plain;",
  "reexports.mjs":
    "export { 'kebab-name' as renamed, plain as 'quoted again' } from './strings.mjs';",
  "star.mjs": "export * from './strings.mjs';",
  "reads-star.mjs": "import { 'with space' as spaced } from './star.mjs'; export { spaced };",
  "kebab.cjs": "exports['kebab-name'] = 'from cjs'; exports.plain = 'plain cjs';",
  "reads-cjs.mjs":
    "import { 'kebab-name' as kebab, 'plain' as plain } from './kebab.cjs'; export const both = [kebab, plain];",
  "live.mjs":
    "let count = 0; export function bump() { count += 1; } export { count as 'the count' };",
  "as-function.mjs": [
    "function plugin() { return 'called'; }",
    "plugin.extra = 'extra';",
    "export default plugin;",
    "export const named = 'named';",
    "export { plugin as 'module.exports' };",
  ].join("\n"),
  "imports-function.mjs":
    "import plugin, { named } from './as-function.mjs'; export const result = [plugin(), named];",
};
for (const [name, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), text);
}

// Keys are sorted here: Node lists a namespace's names in order, webnode in
// the order the module declares them.
const names = (namespace) => Object.keys(namespace).sort();

const strings = require(path.join(dir, "strings.mjs"));
console.log(names(strings), strings["kebab-name"], strings["with space"], strings.plain);
console.log(require(path.join(dir, "reads-strings.mjs")).sum);

const reexports = require(path.join(dir, "reexports.mjs"));
console.log(names(reexports), reexports.renamed, reexports["quoted again"]);

console.log(require(path.join(dir, "reads-star.mjs")).spaced);
console.log(require(path.join(dir, "reads-cjs.mjs")).both);

// A string-named export is a live binding like any other.
const live = require(path.join(dir, "live.mjs"));
live.bump();
live.bump();
console.log(live["the count"], names(live));

// require() hands back the "module.exports" export, not the namespace.
const plugin = require(path.join(dir, "as-function.mjs"));
console.log(typeof plugin, plugin(), plugin.extra, plugin.named);

(async () => {
  // import() still sees the whole namespace.
  const namespace = await import(path.join(dir, "as-function.mjs"));
  console.log(names(namespace), namespace.default === plugin, namespace.named);
  console.log((await import(path.join(dir, "imports-function.mjs"))).result);
  fs.rmSync(dir, { recursive: true, force: true });
})();
