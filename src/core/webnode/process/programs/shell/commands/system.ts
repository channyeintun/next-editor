// `whoami`, `hostname` and `uname`: what the runtime says it is.
import { ARCH, HOSTNAME, USERNAME } from "../../../platform";
import type { Command } from "../context";

/** `whoami`. */
export const whoami: Command = (ctx) => {
  ctx.io.out(`${ctx.env.USER ?? USERNAME}\n`);
  return 0;
};

/** `hostname`. */
export const hostname: Command = (ctx, args) => {
  if (args.length > 0 && !args[0].startsWith("-")) {
    ctx.io.err("hostname: you must be root to change the host name\n");
    return 1;
  }
  ctx.io.out(`${HOSTNAME}\n`);
  return 0;
};

/** `uname [-asnrvmpio]`. */
export const uname: Command = (ctx, args) => {
  const machine = ARCH === "x64" ? "x86_64" : ARCH;
  const fields: Record<string, string> = {
    s: "Linux",
    n: HOSTNAME,
    r: "5.0.0-webnode",
    v: "#1 SMP",
    m: machine,
    p: machine,
    i: machine,
    o: "GNU/Linux",
  };
  let letters = "";
  for (const arg of args) {
    const long: Record<string, string> = {
      "--all": "a",
      "--kernel-name": "s",
      "--nodename": "n",
      "--kernel-release": "r",
      "--kernel-version": "v",
      "--machine": "m",
      "--processor": "p",
      "--hardware-platform": "i",
      "--operating-system": "o",
    };
    if (long[arg]) {
      letters += long[arg];
    } else if (/^-[asnrvmpio]+$/.test(arg)) {
      letters += arg.slice(1);
    } else {
      ctx.io.err(`uname: invalid option -- '${arg.replace(/^-+/, "")}'\n`);
      return 1;
    }
  }
  if (letters === "") {
    letters = "s";
  }
  const order = letters.includes("a")
    ? ["s", "n", "r", "v", "m", "o"]
    : ["s", "n", "r", "v", "m", "p", "i", "o"].filter((l) => letters.includes(l));
  ctx.io.out(`${order.map((letter) => fields[letter]).join(" ")}\n`);
  return 0;
};
