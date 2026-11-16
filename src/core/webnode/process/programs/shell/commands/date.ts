// `date [-u] [-d when] [-I] [+format]`: the default format and the common
// `%` conversions.
import type { Command } from "../context";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface Parts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
  weekday: number;
  offsetMinutes: number;
  zone: string;
}

function partsOf(date: Date, utc: boolean): Parts {
  if (utc) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      hours: date.getUTCHours(),
      minutes: date.getUTCMinutes(),
      seconds: date.getUTCSeconds(),
      ms: date.getUTCMilliseconds(),
      weekday: date.getUTCDay(),
      offsetMinutes: 0,
      zone: "UTC",
    };
  }
  let zone = "UTC";
  try {
    zone =
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  } catch {
    zone = "UTC";
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
    ms: date.getMilliseconds(),
    weekday: date.getDay(),
    offsetMinutes: -date.getTimezoneOffset(),
    zone,
  };
}

const two = (n: number): string => String(n).padStart(2, "0");

/** Formats a date with `date`'s `%` conversions. */
export function formatDate(date: Date, format: string, utc: boolean): string {
  const p = partsOf(date, utc);
  const offset = (): string => {
    const sign = p.offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(p.offsetMinutes);
    return `${sign}${two(Math.floor(abs / 60))}${two(abs % 60)}`;
  };
  const dayOfYear = (): number => {
    const start = utc ? Date.UTC(p.year, 0, 1) : new Date(p.year, 0, 1).getTime();
    const now = utc ? Date.UTC(p.year, p.month, p.day) : new Date(p.year, p.month, p.day).getTime();
    return Math.round((now - start) / 86400000) + 1;
  };
  const hour12 = p.hours % 12 === 0 ? 12 : p.hours % 12;
  const conversions: Record<string, () => string> = {
    Y: () => String(p.year),
    y: () => two(p.year % 100),
    C: () => two(Math.floor(p.year / 100)),
    m: () => two(p.month + 1),
    d: () => two(p.day),
    e: () => String(p.day).padStart(2, " "),
    H: () => two(p.hours),
    k: () => String(p.hours).padStart(2, " "),
    I: () => two(hour12),
    l: () => String(hour12).padStart(2, " "),
    M: () => two(p.minutes),
    S: () => two(p.seconds),
    N: () => String(p.ms * 1000000).padStart(9, "0"),
    p: () => (p.hours < 12 ? "AM" : "PM"),
    P: () => (p.hours < 12 ? "am" : "pm"),
    a: () => DAYS[p.weekday].slice(0, 3),
    A: () => DAYS[p.weekday],
    b: () => MONTHS[p.month].slice(0, 3),
    h: () => MONTHS[p.month].slice(0, 3),
    B: () => MONTHS[p.month],
    j: () => String(dayOfYear()).padStart(3, "0"),
    u: () => String(p.weekday === 0 ? 7 : p.weekday),
    w: () => String(p.weekday),
    s: () => String(Math.floor(date.getTime() / 1000)),
    Z: () => p.zone,
    z: offset,
    T: () => `${two(p.hours)}:${two(p.minutes)}:${two(p.seconds)}`,
    R: () => `${two(p.hours)}:${two(p.minutes)}`,
    D: () => `${two(p.month + 1)}/${two(p.day)}/${two(p.year % 100)}`,
    F: () => `${p.year}-${two(p.month + 1)}-${two(p.day)}`,
    c: () => formatDate(date, "%a %b %e %H:%M:%S %Y", utc),
    x: () => formatDate(date, "%m/%d/%y", utc),
    X: () => formatDate(date, "%H:%M:%S", utc),
    n: () => "\n",
    t: () => "\t",
    "%": () => "%",
  };
  return format.replace(/%([-_0^#]?)([a-zA-Z%])/g, (whole, flag: string, letter: string) => {
    const conversion = conversions[letter];
    if (!conversion) {
      return whole;
    }
    let value = conversion();
    if (flag === "-") {
      value = value.replace(/^[0 ]+(?=.)/, "");
    } else if (flag === "_") {
      value = value.replace(/^0/, " ");
    } else if (flag === "^") {
      value = value.toUpperCase();
    }
    return value;
  });
}

/** `date`. */
export const date: Command = (ctx, args) => {
  let utc = false;
  let when = new Date();
  let format = "%a %b %e %H:%M:%S %Z %Y";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-u" || arg === "--utc" || arg === "--universal") {
      utc = true;
    } else if (arg === "-d" || arg === "--date" || arg.startsWith("--date=")) {
      const text = arg.startsWith("--date=") ? arg.slice(7) : (args[++i] ?? "");
      const parsed = text.startsWith("@")
        ? Number(text.slice(1)) * 1000
        : text === "now"
          ? Date.now()
          : Date.parse(text);
      if (Number.isNaN(parsed)) {
        ctx.io.err(`date: invalid date '${text}'\n`);
        return 1;
      }
      when = new Date(parsed);
    } else if (arg === "-I" || arg.startsWith("--iso-8601")) {
      format = "%F";
    } else if (arg === "-R" || arg === "--rfc-email") {
      format = "%a, %d %b %Y %H:%M:%S %z";
    } else if (arg.startsWith("-I")) {
      format = arg === "-Iseconds" ? "%FT%T%z" : "%F";
    } else if (arg.startsWith("+")) {
      format = arg.slice(1);
    } else {
      ctx.io.err(`date: setting the date: not supported ('${arg}')\n`);
      return 1;
    }
  }
  ctx.io.out(`${formatDate(when, format, utc)}\n`);
  return 0;
};
