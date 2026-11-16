// `env [-i] [-u name] [name=value…] [command [args…]]`: prints the
// environment, or runs a command with a changed one.
import type { Command } from "../context";

/** `env`. */
export const env: Command = (ctx, args) => {
  let vars: Record<string, string> = { ...ctx.env };
  let i = 0;
  let nullEnd = false;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-i" || arg === "-" || arg === "--ignore-environment") {
      vars = {};
    } else if (arg === "-u" || arg === "--unset") {
      delete vars[args[++i] ?? ""];
    } else if (arg.startsWith("-u") && arg.length > 2) {
      delete vars[arg.slice(2)];
    } else if (arg === "-0" || arg === "--null") {
      nullEnd = true;
    } else if (arg === "--") {
      i++;
      break;
    } else if (arg.startsWith("-") && !arg.includes("=")) {
      ctx.io.err(`env: invalid option -- '${arg.slice(1)}'\n`);
      return 125;
    } else {
      break;
    }
  }
  for (; i < args.length; i++) {
    const eq = args[i].indexOf("=");
    if (eq <= 0) {
      break;
    }
    vars[args[i].slice(0, eq)] = args[i].slice(eq + 1);
  }
  const command = args.slice(i);
  if (command.length === 0) {
    ctx.io.out(
      Object.entries(vars)
        .map(([name, value]) => `${name}=${value}${nullEnd ? "\0" : "\n"}`)
        .join(""),
    );
    return 0;
  }
  return ctx.exec(command, vars, true);
};
