// `seq [-s sep] [-w] [first [step]] last`.
import type { Command } from "../context";

/** `seq`. */
export const seq: Command = (ctx, args) => {
  let separator = "\n";
  let equalWidth = false;
  const numbers: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s") {
      separator = args[++i] ?? "\n";
    } else if (arg.startsWith("-s") && !/^-\d/.test(arg)) {
      separator = arg.slice(2);
    } else if (arg === "-w") {
      equalWidth = true;
    } else {
      numbers.push(arg);
    }
  }
  if (numbers.length === 0 || numbers.length > 3 || numbers.some((n) => Number.isNaN(Number(n)))) {
    ctx.io.err(
      numbers.length === 0
        ? "seq: missing operand\n"
        : `seq: invalid floating point argument: '${numbers.find((n) => Number.isNaN(Number(n))) ?? numbers[3]}'\n`,
    );
    return 1;
  }
  const first = numbers.length > 1 ? Number(numbers[0]) : 1;
  const step = numbers.length > 2 ? Number(numbers[1]) : 1;
  const last = Number(numbers[numbers.length - 1]);
  if (step === 0) {
    ctx.io.err("seq: invalid Zero increment value: '0'\n");
    return 1;
  }
  const decimals = Math.max(...numbers.map((n) => (n.includes(".") ? n.split(".")[1].length : 0)));
  const values: string[] = [];
  for (let n = first; step > 0 ? n <= last + 1e-9 : n >= last - 1e-9; n += step) {
    values.push(n.toFixed(decimals));
    if (values.length > 1000000) {
      break;
    }
  }
  if (equalWidth) {
    const width = values.reduce((most, value) => Math.max(most, value.length), 0);
    for (let i = 0; i < values.length; i++) {
      const negative = values[i].startsWith("-");
      values[i] =
        (negative ? "-" : "") +
        values[i].replace("-", "").padStart(width - (negative ? 1 : 0), "0");
    }
  }
  if (values.length > 0) {
    ctx.io.out(`${values.join(separator)}\n`);
  }
  return 0;
};
