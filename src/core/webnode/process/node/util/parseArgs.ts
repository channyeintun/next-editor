// Owns `util.parseArgs`: a port of Node 22's lib/internal/util/parse_args,
// with its tokens, `strict`, `allowPositionals`, `allowNegative`, `default` and
// the `ERR_PARSE_ARGS_*` errors.
import {
  invalidArgType,
  invalidArgValue,
  nodeError,
  validateArray,
  validateBoolean,
  validateObject,
  validateString,
} from "./nodeErrors";

type OptionValue = string | boolean | (string | boolean)[];

interface OptionConfig {
  type?: unknown;
  short?: unknown;
  multiple?: unknown;
  default?: unknown;
}

type Options = Record<string, OptionConfig>;

/** One token of `parseArgs({ tokens: true })`. */
export type ParseArgsToken =
  | {
      kind: "option";
      name: string;
      rawName: string;
      index: number;
      value: string | undefined;
      inlineValue: boolean | undefined;
    }
  | { kind: "positional"; index: number; value: string }
  | { kind: "option-terminator"; index: number };

/** What `parseArgs` returns. */
export interface ParseArgsResult {
  values: Record<string, OptionValue | undefined>;
  positionals: string[];
  tokens?: ParseArgsToken[];
}

/** The `config` `parseArgs` takes. */
export interface ParseArgsConfig {
  args?: string[];
  options?: Record<string, OptionConfig>;
  strict?: boolean;
  allowPositionals?: boolean;
  allowNegative?: boolean;
  tokens?: boolean;
}

interface ProcessLike {
  argv?: string[];
  execArgv?: string[];
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function objectGetOwn(obj: object, prop: string): unknown {
  if (hasOwn(obj, prop)) {
    return (obj as Record<string, unknown>)[prop];
  }
  return undefined;
}

function optionsGetOwn(options: Options, longOption: string, prop: string): unknown {
  if (hasOwn(options, longOption)) {
    return objectGetOwn(options[longOption], prop);
  }
  return undefined;
}

function parseArgsError(code: string, message: string): Error {
  return nodeError(TypeError, code, message);
}

function getMainArgs(): string[] {
  const proc = (globalThis as { process?: ProcessLike }).process;
  const argv = proc?.argv ?? [];
  const execArgv = proc?.execArgv ?? [];
  if (
    execArgv.includes("-e") ||
    execArgv.includes("--eval") ||
    execArgv.includes("-p") ||
    execArgv.includes("--print")
  ) {
    return argv.slice(1);
  }
  return argv.slice(2);
}

function isOptionValue(value: string | undefined): boolean {
  return value != null;
}

function isOptionLikeValue(value: string | undefined): boolean {
  if (value == null) {
    return false;
  }
  return value.length > 1 && value.charAt(0) === "-";
}

function isLoneShortOption(arg: string): boolean {
  return arg.length === 2 && arg.charAt(0) === "-" && arg.charAt(1) !== "-";
}

function isLoneLongOption(arg: string): boolean {
  return arg.length > 2 && arg.startsWith("--") && !arg.includes("=", 3);
}

function isLongOptionAndValue(arg: string): boolean {
  return arg.length > 2 && arg.startsWith("--") && arg.includes("=", 3);
}

function findLongOptionForShort(shortOption: string, options: Options): string {
  const entry = Object.entries(options).find(
    ([, optionConfig]) => objectGetOwn(optionConfig, "short") === shortOption,
  );
  return entry?.[0] ?? shortOption;
}

function isShortOptionGroup(arg: string, options: Options): boolean {
  if (arg.length <= 2 || arg.charAt(0) !== "-" || arg.charAt(1) === "-") {
    return false;
  }
  const longOption = findLongOptionForShort(arg.charAt(1), options);
  return optionsGetOwn(options, longOption, "type") !== "string";
}

function isShortOptionAndValue(arg: string, options: Options): boolean {
  if (arg.length <= 2 || arg.charAt(0) !== "-" || arg.charAt(1) === "-") {
    return false;
  }
  const longOption = findLongOptionForShort(arg.charAt(1), options);
  return optionsGetOwn(options, longOption, "type") === "string";
}

function useDefaultValueOption(
  longOption: string,
  optionConfig: OptionConfig,
  values: Record<string, unknown>,
): boolean {
  return objectGetOwn(optionConfig, "default") !== undefined && values[longOption] === undefined;
}

function storeOption(
  longOption: string,
  optionValue: string | undefined,
  options: Options,
  values: Record<string, OptionValue | undefined>,
  allowNegative: boolean,
): void {
  if (longOption === "__proto__") {
    return;
  }
  let newValue: string | boolean = optionValue ?? true;
  if (allowNegative && longOption.startsWith("no-") && optionValue === undefined) {
    // Boolean option negation: --no-foo
    longOption = longOption.slice(3);
    newValue = false;
  }
  if (optionsGetOwn(options, longOption, "multiple")) {
    const current = values[longOption];
    if (current) {
      (current as (string | boolean)[]).push(newValue);
    } else {
      values[longOption] = [newValue];
    }
  } else {
    values[longOption] = newValue;
  }
}

function storeDefaultOption(
  longOption: string,
  optionValue: unknown,
  values: Record<string, unknown>,
): void {
  if (longOption === "__proto__") {
    return;
  }
  values[longOption] = optionValue;
}

type OptionToken = Extract<ParseArgsToken, { kind: "option" }>;

function checkOptionLikeValue(token: OptionToken): void {
  if (!token.inlineValue && isOptionLikeValue(token.value)) {
    const example = token.rawName.startsWith("--")
      ? `'${token.rawName}=-XYZ'`
      : `'--${token.name}=-XYZ' or '${token.rawName}-XYZ'`;
    const errorMessage = `Option '${token.rawName}' argument is ambiguous.
Did you forget to specify the option argument for '${token.rawName}'?
To specify an option argument starting with a dash use ${example}.`;
    throw parseArgsError("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", errorMessage);
  }
}

function unknownOption(option: string, allowPositionals: boolean): Error {
  const suggestDashDash = allowPositionals
    ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(option)}`
    : "";
  return parseArgsError(
    "ERR_PARSE_ARGS_UNKNOWN_OPTION",
    `Unknown option '${option}'${suggestDashDash}`,
  );
}

function checkOptionUsage(
  config: { options: Options; allowPositionals: boolean; allowNegative: boolean },
  token: OptionToken,
): void {
  let tokenName = token.name;
  if (!hasOwn(config.options, tokenName)) {
    if (config.allowNegative && tokenName.startsWith("no-")) {
      tokenName = tokenName.slice(3);
      if (
        !hasOwn(config.options, tokenName) ||
        optionsGetOwn(config.options, tokenName, "type") !== "boolean"
      ) {
        throw unknownOption(token.rawName, config.allowPositionals);
      }
    } else {
      throw unknownOption(token.rawName, config.allowPositionals);
    }
  }
  const short = optionsGetOwn(config.options, tokenName, "short");
  const shortAndLong = `${short ? `-${String(short)}, ` : ""}--${tokenName}`;
  const type = optionsGetOwn(config.options, tokenName, "type");
  if (type === "string" && typeof token.value !== "string") {
    throw parseArgsError(
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
      `Option '${shortAndLong} <value>' argument missing`,
    );
  }
  if (type === "boolean" && token.value != null) {
    throw parseArgsError(
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
      `Option '${shortAndLong}' does not take an argument`,
    );
  }
}

function argsToTokens(args: string[], options: Options): ParseArgsToken[] {
  const tokens: ParseArgsToken[] = [];
  let index = -1;
  let groupCount = 0;
  const remainingArgs = args.slice();
  while (remainingArgs.length > 0) {
    const arg = remainingArgs.shift() as string;
    const nextArg = remainingArgs[0];
    if (groupCount > 0) {
      groupCount--;
    } else {
      index++;
    }

    if (arg === "--") {
      tokens.push({ kind: "option-terminator", index });
      for (const rest of remainingArgs) {
        tokens.push({ kind: "positional", index: ++index, value: rest });
      }
      break;
    }

    if (isLoneShortOption(arg)) {
      const shortOption = arg.charAt(1);
      const longOption = findLongOptionForShort(shortOption, options);
      let value: string | undefined;
      let inlineValue: boolean | undefined;
      if (optionsGetOwn(options, longOption, "type") === "string" && isOptionValue(nextArg)) {
        value = remainingArgs.shift();
        inlineValue = false;
      }
      tokens.push({ kind: "option", name: longOption, rawName: arg, index, value, inlineValue });
      if (value != null) {
        ++index;
      }
      continue;
    }

    if (isShortOptionGroup(arg, options)) {
      const expanded: string[] = [];
      for (let i = 1; i < arg.length; i++) {
        const shortOption = arg.charAt(i);
        const longOption = findLongOptionForShort(shortOption, options);
        if (optionsGetOwn(options, longOption, "type") !== "string" || i === arg.length - 1) {
          expanded.push(`-${shortOption}`);
        } else {
          // A string option in the middle takes the rest: -abfFILE is -a -b -fFILE.
          expanded.push(`-${arg.slice(i)}`);
          break;
        }
      }
      remainingArgs.unshift(...expanded);
      groupCount = expanded.length;
      continue;
    }

    if (isShortOptionAndValue(arg, options)) {
      const shortOption = arg.charAt(1);
      const longOption = findLongOptionForShort(shortOption, options);
      tokens.push({
        kind: "option",
        name: longOption,
        rawName: `-${shortOption}`,
        index,
        value: arg.slice(2),
        inlineValue: true,
      });
      continue;
    }

    if (isLoneLongOption(arg)) {
      const longOption = arg.slice(2);
      let value: string | undefined;
      let inlineValue: boolean | undefined;
      if (optionsGetOwn(options, longOption, "type") === "string" && isOptionValue(nextArg)) {
        value = remainingArgs.shift();
        inlineValue = false;
      }
      tokens.push({ kind: "option", name: longOption, rawName: arg, index, value, inlineValue });
      if (value != null) {
        ++index;
      }
      continue;
    }

    if (isLongOptionAndValue(arg)) {
      const equalIndex = arg.indexOf("=");
      const longOption = arg.slice(2, equalIndex);
      tokens.push({
        kind: "option",
        name: longOption,
        rawName: `--${longOption}`,
        index,
        value: arg.slice(equalIndex + 1),
        inlineValue: true,
      });
      continue;
    }

    tokens.push({ kind: "positional", index, value: arg });
  }
  return tokens;
}

function validateStringArray(value: unknown, name: string): void {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) {
    validateString(value[i], `${name}[${i}]`);
  }
}

function validateBooleanArray(value: unknown, name: string): void {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) {
    validateBoolean(value[i], `${name}[${i}]`);
  }
}

/** `util.parseArgs(config)`. */
export function parseArgs(config: ParseArgsConfig = {}): ParseArgsResult {
  const args = (objectGetOwn(config, "args") ?? getMainArgs()) as string[];
  const strict = (objectGetOwn(config, "strict") ?? true) as boolean;
  const allowPositionals = (objectGetOwn(config, "allowPositionals") ?? !strict) as boolean;
  const returnTokens = (objectGetOwn(config, "tokens") ?? false) as boolean;
  const allowNegative = (objectGetOwn(config, "allowNegative") ?? false) as boolean;
  const options = (objectGetOwn(config, "options") ?? Object.create(null)) as Options;
  const parseConfig = { args, strict, options, allowPositionals, allowNegative };

  validateArray(args, "args");
  validateBoolean(strict, "strict");
  validateBoolean(allowPositionals, "allowPositionals");
  validateBoolean(returnTokens, "tokens");
  validateBoolean(allowNegative, "allowNegative");
  validateObject(options, "options");
  for (const [longOption, optionConfig] of Object.entries(options)) {
    validateObject(optionConfig, `options.${longOption}`);
    const optionType = objectGetOwn(optionConfig, "type");
    if (optionType !== "string" && optionType !== "boolean") {
      throw invalidArgType(`options.${longOption}.type`, "('string|boolean')", optionType);
    }

    if (hasOwn(optionConfig, "short")) {
      const shortOption = optionConfig.short;
      validateString(shortOption, `options.${longOption}.short`);
      if (shortOption.length !== 1) {
        throw invalidArgValue(
          `options.${longOption}.short`,
          shortOption,
          "must be a single character",
        );
      }
    }

    const multipleOption = objectGetOwn(optionConfig, "multiple");
    if (hasOwn(optionConfig, "multiple")) {
      validateBoolean(multipleOption, `options.${longOption}.multiple`);
    }

    const defaultValue = objectGetOwn(optionConfig, "default");
    if (defaultValue !== undefined) {
      const name = `options.${longOption}.default`;
      if (optionType === "string") {
        if (multipleOption) {
          validateStringArray(defaultValue, name);
        } else {
          validateString(defaultValue, name);
        }
      } else if (multipleOption) {
        validateBooleanArray(defaultValue, name);
      } else {
        validateBoolean(defaultValue, name);
      }
    }
  }

  const tokens = argsToTokens(args, options);

  const result: ParseArgsResult = {
    values: Object.create(null) as Record<string, OptionValue | undefined>,
    positionals: [],
  };
  if (returnTokens) {
    result.tokens = tokens;
  }
  for (const token of tokens) {
    if (token.kind === "option") {
      if (strict) {
        checkOptionUsage(parseConfig, token);
        checkOptionLikeValue(token);
      }
      storeOption(token.name, token.value, options, result.values, allowNegative);
    } else if (token.kind === "positional") {
      if (!allowPositionals) {
        throw parseArgsError(
          "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
          `Unexpected argument '${token.value}'. This command does not take positional arguments`,
        );
      }
      result.positionals.push(token.value);
    }
  }

  for (const [longOption, optionConfig] of Object.entries(options)) {
    if (useDefaultValueOption(longOption, optionConfig, result.values)) {
      storeDefaultOption(longOption, objectGetOwn(optionConfig, "default"), result.values);
    }
  }

  return result;
}
