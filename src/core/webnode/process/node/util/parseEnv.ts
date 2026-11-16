// Owns `util.parseEnv`: the `.env` parser Node runs for `--env-file`
// (src/node_dotenv.cc), following its rules for quotes, comments and `export`.
import { validateString } from "./nodeErrors";

function trimSpaces(input: string): string {
  return input.replace(/^[ \t\n\r\f\v]+/, "").replace(/[ \t\n\r\f\v]+$/, "");
}

/** `util.parseEnv(content)`: the variables a `.env` file defines. */
export function parseEnv(content: string): Record<string, string> {
  validateString(content, "content");
  const store: Record<string, string> = {};
  let lines = content.replaceAll("\r", "");
  lines = trimSpaces(lines);
  let rest = lines;
  while (rest.length > 0) {
    // Skip empty lines and comments.
    if (rest[0] === "\n" || rest[0] === "#") {
      const newline = rest.indexOf("\n");
      if (newline !== -1) {
        rest = rest.slice(newline + 1);
        continue;
      }
    }
    // Without an equals sign there is nothing more to read.
    const equal = rest.indexOf("=");
    if (equal === -1) {
      break;
    }
    let key = trimSpaces(rest.slice(0, equal));
    rest = rest.slice(equal + 1);
    if (key.length === 0) {
      const newline = rest.indexOf("\n");
      if (newline !== -1) {
        rest = rest.slice(newline + 1);
        continue;
      }
      break;
    }
    if (key.startsWith("export ")) {
      key = trimSpaces(key.slice(7));
    }
    // A key cannot span lines: everything before the last newline was junk.
    const keyNewline = key.lastIndexOf("\n");
    if (keyNewline !== -1) {
      key = trimSpaces(key.slice(keyNewline + 1));
    }
    if (rest.length === 0) {
      store[key] = "";
      break;
    }
    rest = rest.replace(/^[ \t\f\v]+/, "");
    if (rest.length === 0) {
      store[key] = "";
      break;
    }

    const quote = rest[0];
    // Double quotes expand \n.
    if (quote === '"') {
      const closing = rest.indexOf('"', 1);
      if (closing !== -1) {
        store[key] = rest.slice(1, closing).replaceAll("\\n", "\n");
        const newline = rest.indexOf("\n", closing + 1);
        rest = newline !== -1 ? rest.slice(newline + 1) : "";
        continue;
      }
    }

    if (quote === "'" || quote === '"' || quote === "`") {
      const closing = rest.indexOf(quote, 1);
      if (closing === -1) {
        // No closing quote: the whole line, quote included, is the value.
        const newline = rest.indexOf("\n");
        if (newline !== -1) {
          store[key] = trimSpaces(rest.slice(0, newline));
          rest = rest.slice(newline + 1);
        } else {
          store[key] = trimSpaces(rest);
          rest = "";
        }
      } else {
        store[key] = rest.slice(1, closing);
        const newline = rest.indexOf("\n", closing + 1);
        rest = newline !== -1 ? rest.slice(newline + 1) : "";
      }
      continue;
    }

    // An unquoted value runs to the end of the line, up to a `#` comment.
    const newline = rest.indexOf("\n");
    let value = newline !== -1 ? rest.slice(0, newline) : rest;
    rest = newline !== -1 ? rest.slice(newline + 1) : "";
    const hash = value.indexOf("#");
    if (hash !== -1) {
      value = value.slice(0, hash);
    }
    store[key] = trimSpaces(value);
  }
  return store;
}
