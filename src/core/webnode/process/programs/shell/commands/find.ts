// `find [paths…] [expression]`: -name -iname -path -type -maxdepth -mindepth
// -empty -newer, -not/!, -a, -o, ( ), -prune, -depth, -print, -print0,
// -delete and `-exec cmd {} ;` / `-exec cmd {} +`.
import type { StatData } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import { matchPattern } from "../pattern";
import { baseName, errorText, isDir, isFile, isLink, tryStat } from "./util";

type Expr =
  | { type: "and" | "or"; left: Expr; right: Expr }
  | { type: "not"; expr: Expr }
  | { type: "test"; run: (entry: FindEntry) => boolean }
  | { type: "action"; run: (entry: FindEntry) => boolean | Promise<boolean> };

interface FindEntry {
  path: string;
  label: string;
  stat: StatData;
  depth: number;
  prune: boolean;
}

class FindParser {
  private pos = 0;
  hasAction = false;
  maxDepth = Infinity;
  minDepth = 0;
  /** -depth, or -delete: a directory is evaluated after its entries. */
  depthFirst = false;
  /** An action failed in a way that makes find exit 1 (-delete). */
  failed = false;
  readonly batches: { argv: string[]; paths: string[] }[] = [];
  private readonly args: string[];
  private readonly ctx: CommandContext;

  constructor(ctx: CommandContext, args: string[]) {
    this.ctx = ctx;
    this.args = args;
  }

  parse(): Expr | null {
    if (this.args.length === 0) {
      return null;
    }
    const expr = this.or();
    if (this.pos < this.args.length) {
      throw new Error(`paths must precede expression: '${this.args[this.pos]}'`);
    }
    return expr;
  }

  private or(): Expr {
    let left = this.and();
    while (this.args[this.pos] === "-o" || this.args[this.pos] === "-or") {
      this.pos++;
      left = { type: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    for (;;) {
      const token = this.args[this.pos];
      if (token === "-a" || token === "-and") {
        this.pos++;
        left = { type: "and", left, right: this.not() };
        continue;
      }
      if (token === undefined || token === "-o" || token === "-or" || token === ")") {
        return left;
      }
      left = { type: "and", left, right: this.not() };
    }
  }

  private not(): Expr {
    const token = this.args[this.pos];
    if (token === "!" || token === "-not") {
      this.pos++;
      return { type: "not", expr: this.not() };
    }
    return this.primary();
  }

  private value(name: string): string {
    const value = this.args[++this.pos];
    if (value === undefined) {
      throw new Error(`missing argument to '${name}'`);
    }
    this.pos++;
    return value;
  }

  private primary(): Expr {
    const token = this.args[this.pos];
    switch (token) {
      case "(": {
        this.pos++;
        const inner = this.or();
        if (this.args[this.pos] !== ")") {
          throw new Error(
            "invalid expression; I was expecting to find a ')' somewhere but did not see one.",
          );
        }
        this.pos++;
        return inner;
      }
      case "-name":
      case "-iname": {
        const pattern = this.value(token);
        const insensitive = token === "-iname";
        return {
          type: "test",
          run: (entry) =>
            insensitive
              ? matchPattern(pattern.toLowerCase(), baseName(entry.label).toLowerCase())
              : matchPattern(pattern, baseName(entry.label)),
        };
      }
      case "-path":
      case "-wholename":
      case "-ipath": {
        const pattern = this.value(token);
        const insensitive = token === "-ipath";
        return {
          type: "test",
          run: (entry) =>
            insensitive
              ? matchPattern(pattern.toLowerCase(), entry.label.toLowerCase())
              : matchPattern(pattern, entry.label),
        };
      }
      case "-type": {
        const kind = this.value(token);
        if (!/^[fdl](,[fdl])*$/.test(kind)) {
          throw new Error(`-type: ${kind}: not supported (use f, d or l)`);
        }
        const kinds = kind.split(",");
        return {
          type: "test",
          run: (entry) =>
            kinds.some((k) =>
              k === "f" ? isFile(entry.stat) : k === "d" ? isDir(entry.stat) : isLink(entry.stat),
            ),
        };
      }
      case "-maxdepth":
      case "-mindepth": {
        const value = Number(this.value(token));
        if (!Number.isInteger(value) || value < 0) {
          throw new Error(`invalid argument to ${token}`);
        }
        if (token === "-maxdepth") {
          this.maxDepth = value;
        } else {
          this.minDepth = value;
        }
        return { type: "test", run: () => true };
      }
      case "-empty":
        this.pos++;
        return {
          type: "test",
          run: (entry) =>
            isDir(entry.stat)
              ? runtime().fs.readdir(entry.path).length === 0
              : entry.stat.size === 0,
        };
      case "-newer": {
        const reference = this.value(token);
        const stat = tryStat(this.ctx.resolve(reference));
        if (!stat) {
          throw new Error(`'${reference}': No such file or directory`);
        }
        return { type: "test", run: (entry) => entry.stat.mtimeMs > stat.mtimeMs };
      }
      case "-depth":
        this.pos++;
        this.depthFirst = true;
        return { type: "test", run: () => true };
      case "-true":
        this.pos++;
        return { type: "test", run: () => true };
      case "-false":
        this.pos++;
        return { type: "test", run: () => false };
      case "-prune":
        this.pos++;
        return {
          type: "test",
          run: (entry) => {
            entry.prune = true;
            return true;
          },
        };
      case "-print":
      case "-print0": {
        this.pos++;
        this.hasAction = true;
        const end = token === "-print0" ? "\0" : "\n";
        return {
          type: "action",
          run: (entry) => {
            this.ctx.io.out(entry.label + end);
            return true;
          },
        };
      }
      case "-delete":
        this.pos++;
        this.hasAction = true;
        // As in GNU find: entries go before their directory, so a tree can be
        // deleted at all.
        this.depthFirst = true;
        return {
          type: "action",
          run: (entry) => {
            // GNU find never deletes the starting point `.` itself.
            if (baseName(entry.label) === ".") {
              return true;
            }
            try {
              if (isDir(entry.stat)) {
                runtime().fs.rmdir(entry.path);
              } else {
                runtime().fs.unlink(entry.path);
              }
              return true;
            } catch (error) {
              this.ctx.io.err(`find: cannot delete '${entry.label}': ${errorText(error)}\n`);
              this.failed = true;
              return false;
            }
          },
        };
      case "-exec":
      case "-execdir":
      case "-ok": {
        if (token !== "-exec") {
          throw new Error(`${token}: not supported`);
        }
        this.pos++;
        const argv: string[] = [];
        while (
          this.pos < this.args.length &&
          this.args[this.pos] !== ";" &&
          this.args[this.pos] !== "+"
        ) {
          argv.push(this.args[this.pos++]);
        }
        const terminator = this.args[this.pos];
        if (terminator === undefined || argv.length === 0) {
          throw new Error("missing argument to `-exec'");
        }
        this.pos++;
        this.hasAction = true;
        if (terminator === "+") {
          const batch = { argv, paths: [] as string[] };
          this.batches.push(batch);
          return {
            type: "action",
            run: (entry) => {
              batch.paths.push(entry.label);
              return true;
            },
          };
        }
        return {
          type: "action",
          run: async (entry) => {
            const command = argv.map((arg) => arg.split("{}").join(entry.label));
            return (await this.ctx.exec(command)) === 0;
          },
        };
      }
      default:
        if (token?.startsWith("-")) {
          throw new Error(`unknown predicate '${token}'`);
        }
        throw new Error(`paths must precede expression: '${token}'`);
    }
  }
}

async function evaluate(expr: Expr, entry: FindEntry): Promise<boolean> {
  switch (expr.type) {
    case "and":
      return (await evaluate(expr.left, entry)) && evaluate(expr.right, entry);
    case "or":
      return (await evaluate(expr.left, entry)) || evaluate(expr.right, entry);
    case "not":
      return !(await evaluate(expr.expr, entry));
    case "test":
    case "action":
      return expr.run(entry);
  }
}

/** `find`. */
export const find: Command = async (ctx, args) => {
  let i = 0;
  const paths: string[] = [];
  while (i < args.length && !args[i].startsWith("-") && args[i] !== "!" && args[i] !== "(") {
    paths.push(args[i++]);
  }
  if (paths.length === 0) {
    paths.push(".");
  }
  const parser = new FindParser(ctx, args.slice(i));
  let expr: Expr | null;
  try {
    expr = parser.parse();
  } catch (error) {
    ctx.io.err(`find: ${(error as Error).message}\n`);
    return 1;
  }
  const print = (entry: FindEntry): void => {
    ctx.io.out(`${entry.label}\n`);
  };
  let status = 0;
  const fs = runtime().fs;
  const visit = async (path: string, label: string, depth: number): Promise<void> => {
    let stat: StatData;
    try {
      stat = fs.stat(path, false);
    } catch (error) {
      ctx.io.err(`find: '${label}': ${errorText(error)}\n`);
      status = 1;
      return;
    }
    const entry: FindEntry = { path, label, stat, depth, prune: false };
    const check = async (): Promise<void> => {
      if (depth >= parser.minDepth) {
        const matched = expr ? await evaluate(expr, entry) : true;
        if (matched && !parser.hasAction) {
          print(entry);
        }
      }
    };
    if (!parser.depthFirst) {
      await check();
    }
    if (isDir(stat) && !entry.prune && depth < parser.maxDepth && !ctx.io.broken) {
      let names: string[] | null = null;
      try {
        names = fs.readdir(path).map((child) => child.name);
      } catch (error) {
        ctx.io.err(`find: '${label}': ${errorText(error)}\n`);
        status = 1;
      }
      for (const name of names ?? []) {
        await visit(
          `${path === "/" ? "" : path}/${name}`,
          `${label.endsWith("/") ? label : `${label}/`}${name}`,
          depth + 1,
        );
      }
    }
    if (parser.depthFirst) {
      await check();
    }
  };
  for (const path of paths) {
    await visit(ctx.resolve(path), path, 0);
  }
  if (parser.failed) {
    status = 1;
  }
  for (const batch of parser.batches) {
    if (batch.paths.length === 0) {
      continue;
    }
    const at = batch.argv.indexOf("{}");
    const command =
      at < 0
        ? [...batch.argv, ...batch.paths]
        : [...batch.argv.slice(0, at), ...batch.paths, ...batch.argv.slice(at + 1)];
    if ((await ctx.exec(command)) !== 0) {
      status = 1;
    }
  }
  return status;
};
