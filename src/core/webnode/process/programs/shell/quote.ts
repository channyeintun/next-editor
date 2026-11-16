// Quoting a word so the shell reads it back unchanged (`set -x`, `alias`,
// `export -p`, `printf %q`).

/** Quotes a word for `set -x`, `alias` and `export -p` output. */
export function shellQuote(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
