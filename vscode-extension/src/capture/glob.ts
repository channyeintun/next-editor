// Minimal glob support (**, *, ?) so no dependency is needed; matched
// against root-relative posix paths and display names.
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1; // "**/" also matches zero directories
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (ch === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^(?:${pattern})$`);
}
