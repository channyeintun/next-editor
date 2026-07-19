// Fails when any extension source imports something that resolves outside
// vscode-extension/ (ADR 0001). Allowed: relative imports staying inside the
// package, Node builtins, "vscode", and packages declared in package.json.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageJson = JSON.parse(readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
const declaredPackages = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
  "vscode",
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const scanRoots = ["src", "test", "scripts"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"]);
const skipDirs = new Set(["node_modules", "dist", "dist-test", ".test-vscode"]);

/** @returns {string[]} */
function collectFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!skipDirs.has(entry)) {
        out.push(...collectFiles(full));
      }
    } else if (sourceExtensions.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const importPattern =
  /(?:\bimport\s+(?:[\s\S]*?from\s+)?|\bexport\s+[\s\S]*?from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const violations = [];

for (const root of scanRoots) {
  for (const file of collectFiles(path.join(extensionRoot, root))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      const relFile = path.relative(extensionRoot, file);
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (path.relative(extensionRoot, resolved).startsWith("..")) {
          violations.push(`${relFile}: relative import escapes package: "${specifier}"`);
        }
      } else if (path.isAbsolute(specifier)) {
        violations.push(`${relFile}: absolute import path: "${specifier}"`);
      } else {
        const name = packageNameOf(specifier);
        if (!builtins.has(name) && !declaredPackages.has(name)) {
          violations.push(`${relFile}: undeclared package import: "${specifier}"`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Boundary verification FAILED:");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}
console.log("Boundary verification passed.");
