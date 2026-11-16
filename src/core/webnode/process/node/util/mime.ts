// Owns `util.MIMEType` and `util.MIMEParams`: the WHATWG MIME type parser and
// serializer as Node 22 implements it (lib/internal/mime.js).
import { nodeError } from "./nodeErrors";

const NOT_HTTP_TOKEN_CODE_POINT = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/g;
const NOT_HTTP_QUOTED_STRING_CODE_POINT = /[^\t -~\u0080-ÿ]/g;
const END_BEGINNING_WHITESPACE = /[^\r\n\t ]|$/;
const START_ENDING_WHITESPACE = /[\r\n\t ]*$/;
const EQUALS_SEMICOLON_OR_END = /[;=]|$/;
const QUOTED_VALUE_PATTERN = /^(?:([\\]$)|[\\][\s\S]|[^"])*(?:(")|$)/u;

function search(str: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const match = pattern.exec(str);
  pattern.lastIndex = 0;
  return match === null ? -1 : match.index;
}

function invalidMimeSyntax(production: string, str: string, invalidIndex: number): Error {
  const at = invalidIndex !== -1 ? ` at ${invalidIndex}` : "";
  return nodeError(
    TypeError,
    "ERR_INVALID_MIME_SYNTAX",
    `The MIME syntax for a ${production} in "${str}" is invalid${at}`,
  );
}

function toASCIILower(str: string): string {
  let result = "";
  for (const char of str) {
    result += char >= "A" && char <= "Z" ? char.toLowerCase() : char;
  }
  return result;
}

function parseTypeAndSubtype(str: string): [string, string, number] {
  let position = search(str, END_BEGINNING_WHITESPACE);
  const typeEnd = str.indexOf("/", position);
  const trimmedType = typeEnd === -1 ? str.slice(position) : str.slice(position, typeEnd);
  const invalidTypeIndex = search(trimmedType, NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedType === "" || invalidTypeIndex !== -1 || typeEnd === -1) {
    throw invalidMimeSyntax("type", str, invalidTypeIndex);
  }
  position = typeEnd + 1;
  const type = toASCIILower(trimmedType);
  const subtypeEnd = str.indexOf(";", position);
  const rawSubtype = subtypeEnd === -1 ? str.slice(position) : str.slice(position, subtypeEnd);
  position += rawSubtype.length;
  if (subtypeEnd !== -1) {
    position += 1;
  }
  const trimmedSubtype = rawSubtype.slice(0, search(rawSubtype, START_ENDING_WHITESPACE));
  const invalidSubtypeIndex = search(trimmedSubtype, NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedSubtype === "" || invalidSubtypeIndex !== -1) {
    throw invalidMimeSyntax("subtype", str, invalidSubtypeIndex);
  }
  return [type, toASCIILower(trimmedSubtype), position];
}

function removeBackslashes(str: string): string {
  let ret = "";
  let i;
  for (i = 0; i < str.length - 1; i++) {
    const c = str[i];
    if (c === "\\") {
      i++;
      ret += str[i];
    } else {
      ret += c;
    }
  }
  if (i === str.length - 1) {
    ret += str[i];
  }
  return ret;
}

function encode(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (search(value, NOT_HTTP_TOKEN_CODE_POINT) === -1) {
    return value;
  }
  let escaped = "";
  for (const char of value) {
    escaped += char === '"' || char === "\\" ? `\\${char}` : char;
  }
  return `"${escaped}"`;
}

let attachSource: (params: MIMEParams, source: string) => void;

/** `util.MIMEParams`: the parameters of a MIME type, parsed on first use. */
export class MIMEParams {
  #data = new Map<string, string>();
  #processed = true;
  #string = "";

  static {
    attachSource = (params, source) => {
      params.#string = source;
      params.#processed = false;
    };
  }

  /** Removes the parameter `name`. */
  delete(name: string): void {
    this.#parse();
    this.#data.delete(name);
  }

  /** The value of `name`, or null. */
  get(name: string): string | null {
    this.#parse();
    return this.#data.has(name) ? (this.#data.get(name) as string) : null;
  }

  /** Whether `name` is present. */
  has(name: string): boolean {
    this.#parse();
    return this.#data.has(name);
  }

  /** Sets `name` to `value`, validating both. */
  set(name: string, value: string): void {
    this.#parse();
    name = `${name}`;
    value = `${value}`;
    const invalidNameIndex = search(name, NOT_HTTP_TOKEN_CODE_POINT);
    if (name.length === 0 || invalidNameIndex !== -1) {
      throw invalidMimeSyntax("parameter name", name, invalidNameIndex);
    }
    const invalidValueIndex = search(value, NOT_HTTP_QUOTED_STRING_CODE_POINT);
    if (invalidValueIndex !== -1) {
      throw invalidMimeSyntax("parameter value", value, invalidValueIndex);
    }
    this.#data.set(name, value);
  }

  /** `[name, value]` pairs. */
  *entries(): IterableIterator<[string, string]> {
    this.#parse();
    yield* this.#data.entries();
  }

  /** Parameter names. */
  *keys(): IterableIterator<string> {
    this.#parse();
    yield* this.#data.keys();
  }

  /** Parameter values. */
  *values(): IterableIterator<string> {
    this.#parse();
    yield* this.#data.values();
  }

  /** `name=value;name2="quoted value"`. */
  toString(): string {
    this.#parse();
    let ret = "";
    for (const [key, value] of this.#data) {
      if (ret.length) {
        ret += ";";
      }
      ret += `${key}=${encode(value)}`;
    }
    return ret;
  }

  /** Same as `toString()`. */
  toJSON(): string {
    return this.toString();
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  #parse(): void {
    if (this.#processed) {
      return;
    }
    const paramsMap = this.#data;
    let position = 0;
    const str = this.#string;
    const endOfSource = search(str.slice(position), START_ENDING_WHITESPACE) + position;
    while (position < endOfSource) {
      position += search(str.slice(position), END_BEGINNING_WHITESPACE);
      const afterParameterName = search(str.slice(position), EQUALS_SEMICOLON_OR_END) + position;
      const parameterString = toASCIILower(str.slice(position, afterParameterName));
      position = afterParameterName;
      if (position < endOfSource) {
        const char = str.charAt(position);
        position += 1;
        if (char === ";") {
          continue;
        }
      }
      if (position >= endOfSource) {
        break;
      }
      const char = str.charAt(position);
      let parameterValue: string;
      if (char === '"') {
        position += 1;
        const insideMatch = QUOTED_VALUE_PATTERN.exec(str.slice(position)) as RegExpExecArray;
        position += insideMatch[0].length;
        const inside =
          insideMatch[1] || insideMatch[2] ? insideMatch[0].slice(0, -1) : insideMatch[0];
        parameterValue = removeBackslashes(inside);
        if (insideMatch[1]) {
          parameterValue += "\\";
        }
      } else {
        const valueEnd = str.indexOf(";", position);
        const rawValue = valueEnd === -1 ? str.slice(position) : str.slice(position, valueEnd);
        position += rawValue.length;
        const trimmedValue = rawValue.slice(0, search(rawValue, START_ENDING_WHITESPACE));
        if (trimmedValue === "") {
          continue;
        }
        parameterValue = trimmedValue;
      }
      if (
        parameterString !== "" &&
        search(parameterString, NOT_HTTP_TOKEN_CODE_POINT) === -1 &&
        search(parameterValue, NOT_HTTP_QUOTED_STRING_CODE_POINT) === -1 &&
        !paramsMap.has(parameterString)
      ) {
        paramsMap.set(parameterString, parameterValue);
      }
      position++;
    }
    this.#processed = true;
  }
}

/** `util.MIMEType`: a parsed `type/subtype;params` string. */
export class MIMEType {
  #type: string;
  #subtype: string;
  #parameters: MIMEParams;

  constructor(input: unknown) {
    const string = `${input as string}`;
    const [type, subtype, position] = parseTypeAndSubtype(string);
    this.#type = type;
    this.#subtype = subtype;
    this.#parameters = new MIMEParams();
    attachSource(this.#parameters, string.slice(position));
  }

  /** The type, lower-cased; assigning validates it. */
  get type(): string {
    return this.#type;
  }
  set type(value: string) {
    value = `${value}`;
    const invalidTypeIndex = search(value, NOT_HTTP_TOKEN_CODE_POINT);
    if (value.length === 0 || invalidTypeIndex !== -1) {
      throw invalidMimeSyntax("type", value, invalidTypeIndex);
    }
    this.#type = toASCIILower(value);
  }

  /** The subtype, lower-cased; assigning validates it. */
  get subtype(): string {
    return this.#subtype;
  }
  set subtype(value: string) {
    value = `${value}`;
    const invalidSubtypeIndex = search(value, NOT_HTTP_TOKEN_CODE_POINT);
    if (value.length === 0 || invalidSubtypeIndex !== -1) {
      throw invalidMimeSyntax("subtype", value, invalidSubtypeIndex);
    }
    this.#subtype = toASCIILower(value);
  }

  /** `type/subtype`. */
  get essence(): string {
    return `${this.#type}/${this.#subtype}`;
  }

  /** The parameters. */
  get params(): MIMEParams {
    return this.#parameters;
  }

  /** The serialized MIME type. */
  toString(): string {
    let ret = `${this.#type}/${this.#subtype}`;
    const paramStr = this.#parameters.toString();
    if (paramStr.length) {
      ret += `;${paramStr}`;
    }
    return ret;
  }

  /** Same as `toString()`. */
  toJSON(): string {
    return this.toString();
  }
}
