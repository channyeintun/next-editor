// The package manager program: `npm`, `pnpm`, `yarn`, `npx`, `pnpx`, `bun` and
// `bunx` are all this one built-in, dispatched here by command. It talks to the
// npm registry straight from the browser and reaches the kernel only through
// `runtime()`.
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { runtime } from "../../runtime";
import { createPackageSpec, parseArgs, splitSpec } from "./cli";
import type { Command, Invocation } from "./cli";
import { PmError, isPmError } from "./errors";
import { runExec } from "./exec";
import type { ExecContext } from "./exec";
import { findLocalBin } from "./exec";
import { LOCK_NAME, install, readLock } from "./install";
import { assertPackageName } from "./names";
import {
  addToManifest,
  findProjectDir,
  readManifest,
  removeFromManifest,
  rootDependencies,
  writeManifest,
} from "./manifest";
import type { Manifest } from "./manifest";
import { Reporter, TOOL_VERSIONS, createRuntimeSink } from "./output";
import type { Tool } from "./output";
import { basename, join, resolvePath } from "./paths";
import { DEFAULT_REGISTRY, createRegistryClient, openTarballCache } from "./registry";
import type { RegistryClient } from "./registry";
import { parseSpec, pickVersion } from "./resolve";
import { listScripts, pathWithBins, runScript, spawnAndWait } from "./scripts";
import type { ScriptContext } from "./scripts";

export { parseArgs } from "./cli";

interface Session {
  invocation: Invocation;
  reporter: Reporter;
  cwd: string;
  registry: () => Promise<RegistryClient>;
}

/** The registry URL: `--registry`, else `npm_config_registry` / `NPM_CONFIG_REGISTRY`, else npmjs. */
export function registryUrl(invocation: Invocation, env: Record<string, string>): string {
  return (
    invocation.registry ||
    env.npm_config_registry ||
    env.NPM_CONFIG_REGISTRY ||
    DEFAULT_REGISTRY
  ).replace(/\/+$/, "");
}

/**
 * Runs the package manager with `argv` (`argv[0]` is the invoked name, e.g.
 * `pnpm`) and resolves with its exit status.
 */
export async function runPackageManager(argv: string[]): Promise<number> {
  const rt = runtime();
  rt.ref();
  const sink = createRuntimeSink();
  const invocation = parseArgs(argv);
  const reporter = new Reporter(invocation.tool, sink);
  let client: RegistryClient | null = null;
  const session: Session = {
    invocation,
    reporter,
    cwd: invocation.dir ? resolvePath(rt.cwd, invocation.dir) : rt.cwd,
    registry: async () => {
      if (!client) {
        client = createRegistryClient({
          fetch: (url, init) => fetch(url, init),
          registry: registryUrl(invocation, rt.env),
          cache: await openTarballCache(),
        });
      }
      return client;
    },
  };
  try {
    return await dispatch(session, invocation.command);
  } catch (error) {
    reporter.error(
      isPmError(error)
        ? error
        : new PmError("EOTHER", error instanceof Error ? error.message : String(error)),
    );
    return 1;
  } finally {
    await sink.flush();
    rt.unref();
  }
}

function projectDir(session: Session): string {
  const dir = findProjectDir(runtime().fs, session.cwd);
  if (dir === null) {
    throw new PmError(
      "ENOPKG",
      `No package.json found in ${session.cwd}`,
      [session.invocation.tool === "npm" ? "Run `npm init -y` to create one." : ""].filter(Boolean),
    );
  }
  return dir;
}

function scriptContext(session: Session, dir: string): ScriptContext {
  return {
    tool: session.invocation.tool,
    reporter: session.reporter,
    projectDir: dir,
    manifest: readManifest(runtime().fs, dir),
  };
}

function execContext(session: Session): ExecContext {
  return { reporter: session.reporter, cwd: session.cwd, registry: session.registry };
}

async function runInstall(session: Session, dir: string, force = false): Promise<number> {
  const result = await install({
    projectDir: dir,
    registry: await session.registry(),
    reporter: session.reporter,
    force,
  });
  return result.status;
}

/** Edits package.json, installs, and puts the old file back when the install fails. */
async function withManifestChange(session: Session, dir: string, next: Manifest): Promise<number> {
  const fs = runtime().fs;
  const path = join(dir, "package.json");
  const original = fs.readFile(path);
  writeManifest(fs, dir, next);
  try {
    return await runInstall(session, dir);
  } catch (error) {
    fs.writeFile(path, original, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    throw error;
  }
}

async function add(session: Session, command: Extract<Command, { kind: "add" }>): Promise<number> {
  const fs = runtime().fs;
  // With no package.json above, the package starts a project in the working directory.
  const dir = findProjectDir(fs, session.cwd) ?? session.cwd;
  const registry = await session.registry();
  const entries: Record<string, string> = {};
  await Promise.all(
    command.specs.map(async (raw) => {
      const { name, range } = splitSpec(raw);
      assertPackageName(name);
      const parsed = parseSpec(name, range ?? "latest");
      if (parsed.kind === "unsupported") {
        throw new PmError(
          "EUNSUPPORTED",
          `${raw}: ${parsed.what} is not supported by this installer`,
        );
      }
      assertPackageName(parsed.source);
      const packument = await registry.packument(parsed.source);
      const version = pickVersion(
        packument,
        parsed.kind === "tag" ? { tag: parsed.tag } : { range: parsed.range },
      );
      if (version === null) {
        throw new PmError("ETARGET", `No matching version found for ${raw}`);
      }
      const saved = command.exact || version.includes("-") ? version : `^${version}`;
      entries[name] = parsed.source === name ? saved : `npm:${parsed.source}@${saved}`;
    }),
  );
  // Adding a package where there is no package.json starts a project, as npm and pnpm do.
  if (!fs.exists(join(dir, "package.json"))) {
    fs.writeFile(
      join(dir, "package.json"),
      new TextEncoder().encode("{}\n"),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
  }
  return withManifestChange(
    session,
    dir,
    addToManifest(readManifest(fs, dir), entries, command.save),
  );
}

async function remove(session: Session, names: string[]): Promise<number> {
  const dir = projectDir(session);
  const fs = runtime().fs;
  const { manifest, removed } = removeFromManifest(readManifest(fs, dir), names);
  const missing = names.filter((name) => !removed.includes(name));
  if (missing.length > 0 && session.invocation.tool !== "npm") {
    throw new PmError(
      "EOTHER",
      `Cannot remove '${missing.join("', '")}': no such dependency found`,
    );
  }
  return withManifestChange(session, dir, manifest);
}

async function run(session: Session, command: Extract<Command, { kind: "run" }>): Promise<number> {
  const dir = projectDir(session);
  const context = scriptContext(session, dir);
  if (command.script === null) {
    listScripts(context);
    return 0;
  }
  const scripts = context.manifest.scripts ?? {};
  if (scripts[command.script] === undefined) {
    if (command.ifPresent) {
      return 0;
    }
    const fs = runtime().fs;
    if (
      session.invocation.tool === "npm" &&
      command.script === "start" &&
      fs.exists(join(dir, "server.js"))
    ) {
      context.manifest = { ...context.manifest, scripts: { ...scripts, start: "node server.js" } };
    }
  }
  return runScript(context, command.script, command.args);
}

async function implicit(session: Session, name: string, args: string[]): Promise<number> {
  const fs = runtime().fs;
  const dir = findProjectDir(fs, session.cwd);
  if (dir !== null) {
    const context = scriptContext(session, dir);
    if (context.manifest.scripts?.[name] !== undefined) {
      return runScript(context, name, args);
    }
  }
  const bin = findLocalBin(session.cwd, name);
  if (bin) {
    await session.reporter.sink.flush();
    return spawnAndWait(bin, args, session.cwd, pathWithBins(runtime().env, session.cwd));
  }
  const tool = session.invocation.tool;
  if (tool === "yarn") {
    throw new PmError("ENOSCRIPT", `Command "${name}" not found.`);
  }
  if (tool === "bun") {
    throw new PmError("ENOSCRIPT", `Script not found "${name}"`);
  }
  throw new PmError("ENOCMD", `Command "${name}" not found`);
}

function init(session: Session, yes: boolean): number {
  const fs = runtime().fs;
  const path = join(session.cwd, "package.json");
  const tool = session.invocation.tool;
  if (fs.exists(path)) {
    if (tool === "pnpm") {
      throw new PmError("EOTHER", "package.json already exists");
    }
    session.reporter.line(`${path} already exists`);
    return 0;
  }
  const name =
    basename(session.cwd)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-") || "project";
  const manifest: Manifest = {
    name,
    version: "1.0.0",
    description: "",
    main: "index.js",
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: [],
    author: "",
    license: "ISC",
  };
  if (tool === "yarn" && !yes) {
    delete manifest.scripts;
  }
  writeManifest(fs, session.cwd, manifest);
  session.reporter.line(`Wrote to ${path}:`);
  session.reporter.line();
  session.reporter.line(JSON.stringify(manifest, null, 2));
  session.reporter.line();
  return 0;
}

function installedVersion(dir: string, location: string): string | null {
  try {
    const manifest = readManifest(runtime().fs, join(dir, location));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function list(session: Session): number {
  const dir = projectDir(session);
  const fs = runtime().fs;
  const manifest = readManifest(fs, dir);
  const tool = session.invocation.tool;
  const { reporter } = session;
  const id = `${manifest.name ?? ""}${manifest.version ? `@${manifest.version}` : ""}`;
  const deps = rootDependencies(manifest).map((dependency) => ({
    ...dependency,
    version: installedVersion(dir, `node_modules/${dependency.name}`),
  }));
  if (tool === "pnpm") {
    reporter.line(`${id ? `${id} ` : ""}${dir}`);
    for (const [type, title] of [
      ["prod", "dependencies"],
      ["optional", "optionalDependencies"],
      ["dev", "devDependencies"],
    ] as const) {
      const group = deps.filter((dependency) => dependency.type === type);
      if (group.length > 0) {
        reporter.line();
        reporter.line(`${title}:`);
        for (const dependency of group) {
          reporter.line(`${dependency.name} ${dependency.version ?? "(not installed)"}`);
        }
      }
    }
    return 0;
  }
  reporter.line(`${id ? `${id} ` : ""}${dir}`);
  deps.forEach((dependency, index) => {
    const branch = index === deps.length - 1 ? "└─" : "├─";
    const version = dependency.version ? `@${dependency.version}` : " UNMET DEPENDENCY";
    reporter.line(`${branch}${tool === "npm" ? "─ " : " "}${dependency.name}${version}`);
  });
  if (deps.length === 0) {
    reporter.line("└── (empty)");
  }
  return 0;
}

function why(session: Session, names: string[]): number {
  const dir = projectDir(session);
  const fs = runtime().fs;
  const lock = readLock(fs, dir);
  const { reporter } = session;
  if (!lock) {
    throw new PmError(
      "EOTHER",
      `No installed packages: run install first (${LOCK_NAME} is missing)`,
    );
  }
  const manifest = readManifest(fs, dir);
  const direct = new Map(
    rootDependencies(manifest).map((dependency) => [dependency.name, dependency]),
  );
  const installed = Object.entries(lock.packages).map(([location, entry]) => ({
    location,
    entry,
    manifest: (() => {
      try {
        return readManifest(fs, join(dir, location));
      } catch {
        return {} as Manifest;
      }
    })(),
  }));
  let found = false;
  for (const name of names) {
    for (const { location, entry } of installed.filter((pkg) => pkg.entry.name === name)) {
      found = true;
      reporter.line(`${name}@${entry.version} ${location}`);
      const rootDependency = direct.get(name);
      if (rootDependency && location === `node_modules/${name}`) {
        reporter.line(
          `  ${rootDependency.type === "dev" ? "dev" : rootDependency.type} dependency of the project (${rootDependency.spec})`,
        );
      }
      for (const pkg of installed) {
        const spec =
          pkg.manifest.dependencies?.[name] ??
          pkg.manifest.optionalDependencies?.[name] ??
          pkg.manifest.peerDependencies?.[name];
        if (spec !== undefined) {
          reporter.line(`  from ${pkg.entry.name}@${pkg.entry.version} (${spec})`);
        }
      }
    }
  }
  if (!found) {
    throw new PmError("EOTHER", `No installed package named ${names.join(", ")}`);
  }
  return 0;
}

function help(tool: Tool, reporter: Reporter): number {
  reporter.line(`Usage: ${tool} <command>`);
  reporter.line();
  reporter.line("Commands:");
  for (const line of [
    "install, i          install the project's dependencies",
    "add <pkg...>        add dependencies (-D, -O, -E, --save-peer)",
    "remove <pkg...>     remove dependencies",
    "run <script>        run a package.json script",
    "exec <bin>          run a bin from node_modules/.bin",
    "dlx <pkg>           run a package's bin without adding it",
    "create <name>       run create-<name>",
    "init                write a package.json",
    "ls                  list the top-level dependencies",
    "why <pkg>           show why a package is installed",
  ]) {
    reporter.line(`  ${line}`);
  }
  reporter.line();
  reporter.line(`${tool} ${TOOL_VERSIONS[tool]} (webnode built-in)`);
  return 0;
}

async function dispatch(session: Session, command: Command): Promise<number> {
  const { reporter, invocation } = session;
  const tool = invocation.tool;
  switch (command.kind) {
    case "version":
      reporter.line(TOOL_VERSIONS[tool]);
      return 0;
    case "help":
      return help(tool, reporter);
    case "install":
      return runInstall(session, projectDir(session));
    case "update":
      return runInstall(session, projectDir(session), true);
    case "add":
      return add(session, command);
    case "remove":
      return remove(session, command.names);
    case "run":
      return run(session, command);
    case "implicit":
      return implicit(session, command.name, command.args);
    case "exec":
      return runExec(execContext(session), command);
    case "create":
      return runExec(execContext(session), {
        mode: "dlx",
        command: null,
        args: command.args,
        packages: [createPackageSpec(command.name)],
        shell: null,
      });
    case "init":
      return init(session, command.yes);
    case "ls":
      return list(session);
    case "why":
      return why(session, command.names);
    case "noop":
      reporter.line(
        `${tool} ${command.name}: nothing to do here (packages live in the in-browser filesystem).`,
      );
      return 0;
    case "global":
      reporter.sink.write(
        2,
        `${tool}: global installs are not supported here; add the package to the project instead.\n`,
      );
      return 1;
    case "unknown":
      throw new PmError("EOTHER", `Unknown command: "${command.name}"`, [
        "",
        `To see a list of supported ${tool} commands, run:`,
        `  ${tool} help`,
      ]);
  }
}
