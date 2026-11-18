// `npx` / `npm exec` / `pnpm exec` / `pnpm dlx` / `yarn dlx` / `bunx` and
// `<tool> create`: run a command from node_modules/.bin (searching up from the
// working directory), else one on PATH, else install its package into
// /tmp/.npx/<name>@<version>/ and run the package's bin from there.
import { TMP_DIR, DEFAULT_PATH } from "../../platform";
import { runtime } from "../../runtime";
import { binEntries } from "./bins";
import { splitSpec } from "./cli";
import type { ExecMode } from "./cli";
import { PmError } from "./errors";
import { assertPackageName, packageNameProblem } from "./names";
import { install } from "./install";
import { readManifest, writeManifest } from "./manifest";
import type { Manifest } from "./manifest";
import type { Reporter } from "./output";
import { basename, join } from "./paths";
import type { RegistryClient } from "./registry";
import { parseSpec, pickVersion } from "./resolve";
import { binDirs, pathWithBins, runForeground, shellQuote } from "./scripts";

export interface ExecRequest {
  mode: ExecMode;
  command: string | null;
  args: string[];
  packages: string[];
  shell: string | null;
}

export interface ExecContext {
  reporter: Reporter;
  cwd: string;
  /** Creates the registry client on first use. */
  registry: () => Promise<RegistryClient>;
}

/** The first `<dir>/node_modules/.bin/<command>` from `cwd` upward, or null. */
export function findLocalBin(cwd: string, command: string): string | null {
  const fs = runtime().fs;
  for (const dir of binDirs(cwd)) {
    const candidate = join(dir, command);
    if (fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** True when `command` is found in one of `PATH`'s directories. */
export function onPath(command: string, path: string): boolean {
  const fs = runtime().fs;
  return path
    .split(":")
    .filter(Boolean)
    .some((dir) => fs.exists(join(dir, command)));
}

/** The exact version `spec` (`name`, `name@range`, `name@tag`) selects in the registry. */
async function resolveSpec(
  registry: RegistryClient,
  spec: string,
): Promise<{ name: string; version: string }> {
  const { name, range } = splitSpec(spec);
  assertPackageName(name);
  const parsed = parseSpec(name, range ?? "latest");
  if (parsed.kind === "unsupported") {
    throw new PmError("EUNSUPPORTED", `${spec}: ${parsed.what} is not supported by this installer`);
  }
  assertPackageName(parsed.source);
  const packument = await registry.packument(parsed.source);
  const version = pickVersion(
    packument,
    parsed.kind === "tag" ? { tag: parsed.tag } : { range: parsed.range },
  );
  if (version === null) {
    throw new PmError("ETARGET", `No matching version found for ${spec}`);
  }
  return { name, version };
}

/**
 * Installs `specs` into their own directory under /tmp/.npx and returns it
 * with the resolved packages. A directory installed before is reused.
 */
export async function installTemporary(
  context: ExecContext,
  specs: string[],
): Promise<{ dir: string; packages: { name: string; version: string }[] }> {
  const registry = await context.registry();
  const packages = await Promise.all(specs.map((spec) => resolveSpec(registry, spec)));
  const id = packages
    .map((pkg) => `${pkg.name}@${pkg.version}`)
    .join("+")
    .replace(/\//g, "+");
  const dir = join(TMP_DIR, ".npx", id);
  const fs = runtime().fs;
  if (!fs.exists(join(dir, "package.json"))) {
    if (context.reporter.tool === "npm") {
      context.reporter.warn(
        `exec The following package${packages.length === 1 ? " was" : "s were"} not found and will be installed: ${packages
          .map((pkg) => `${pkg.name}@${pkg.version}`)
          .join(", ")}`,
      );
    }
    fs.mkdir(dir, true, 0o755);
    const manifest: Manifest = {
      name: "webnode-npx",
      private: true,
      dependencies: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version])),
    };
    writeManifest(fs, dir, manifest);
  }
  const result = await install({
    projectDir: dir,
    registry,
    reporter: context.reporter,
    quiet: true,
    runScripts: false,
  });
  if (result.status !== 0) {
    throw new PmError("EOTHER", `Could not install ${specs.join(", ")}`);
  }
  return { dir, packages };
}

/** The bin a package runs when `npx <package>` names no command. */
export function defaultBin(manifest: Manifest, packageName: string): string | null {
  const entries = binEntries(manifest);
  if (entries.length === 1) {
    return entries[0][0];
  }
  const short = packageName.slice(packageName.lastIndexOf("/") + 1);
  const match = entries.find(([name]) => name === short);
  return match ? match[0] : null;
}

/**
 * The bin of `name` when the package is installed in a node_modules from
 * `cwd` upward (`npx @tailwindcss/cli` in a project that has it), or null.
 */
function findLocalPackageBin(cwd: string, name: string): string | null {
  const fs = runtime().fs;
  for (const dir of binDirs(cwd)) {
    const packageDir = join(dir, "..", name);
    if (!fs.exists(join(packageDir, "package.json"))) {
      continue;
    }
    let bin: string | null = null;
    try {
      bin = defaultBin(readManifest(fs, packageDir), name);
    } catch {
      // A broken package.json: install a fresh copy instead.
    }
    return bin !== null && fs.exists(join(dir, bin)) ? join(dir, bin) : null;
  }
  return null;
}

function notFound(context: ExecContext, command: string): PmError {
  const tool = context.reporter.tool;
  if (tool === "npm") {
    return new PmError("ENOCMD", `could not determine executable to run`);
  }
  if (tool === "yarn") {
    return new PmError("ENOCMD", `Command "${command}" not found.`);
  }
  return new PmError("ENOCMD", `Command "${command}" not found`);
}

/** Runs an exec request. Resolves with the command's exit status. */
export async function runExec(context: ExecContext, request: ExecRequest): Promise<number> {
  const rt = runtime();
  const base = rt.env;
  const cwd = context.cwd;
  const withLocal = pathWithBins(base, cwd);

  if (request.shell !== null) {
    let env = withLocal;
    if (request.packages.length > 0) {
      const { dir } = await installTemporary(context, request.packages);
      env = { ...withLocal, PATH: `${join(dir, "node_modules/.bin")}:${withLocal.PATH}` };
    }
    return runForeground(context.reporter, "sh", ["-c", request.shell], env, {
      cwd,
      line: request.shell,
      event: null,
      install: false,
    });
  }

  if (request.command === null && request.packages.length === 0) {
    throw notFound(context, "");
  }

  const run = (command: string, env: Record<string, string>) =>
    runForeground(context.reporter, command, request.args, env, {
      cwd,
      // As npm shows a command it ran by name: the name quoted, then its arguments.
      line: [`'${request.command ?? basename(command)}'`, ...request.args.map(shellQuote)].join(
        " ",
      ),
      event: null,
      install: false,
    });

  if (request.command !== null && request.mode !== "dlx" && request.packages.length === 0) {
    const local = findLocalBin(cwd, request.command);
    if (local) {
      return run(local, withLocal);
    }
    // A `/` makes the command a path, unless it is a scoped package name (`@scope/cli`).
    const spec = splitSpec(request.command);
    if (request.command.includes("/") && packageNameProblem(spec.name) === null) {
      const bin = spec.range === null ? findLocalPackageBin(cwd, spec.name) : null;
      if (bin) {
        return run(bin, withLocal);
      }
    } else if (
      request.command.includes("/") ||
      onPath(request.command, base.PATH ?? DEFAULT_PATH)
    ) {
      return run(request.command, withLocal);
    }
    if (request.mode === "local") {
      throw notFound(context, request.command);
    }
  }

  const specs = request.packages.length > 0 ? request.packages : [request.command!];
  const { dir, packages } = await installTemporary(context, specs);
  const tempBins = join(dir, "node_modules/.bin");
  const env = { ...withLocal, PATH: `${tempBins}:${withLocal.PATH}` };
  let bin: string | null;
  if (request.command !== null && request.packages.length > 0) {
    bin = request.command;
  } else {
    const first = packages[0];
    const manifest = readManifest(rt.fs, join(dir, "node_modules", first.name));
    bin = defaultBin(manifest, first.name);
  }
  if (bin === null) {
    throw notFound(context, request.command ?? packages[0].name);
  }
  const local = join(tempBins, bin);
  if (rt.fs.exists(local)) {
    return run(local, env);
  }
  if (onPath(bin, env.PATH)) {
    return run(bin, env);
  }
  throw notFound(context, [bin, ...request.args].map(shellQuote).join(" "));
}
