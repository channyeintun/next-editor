// What a background command reads in a shell without job control. bash
// gives it /dev/null, so that it never takes input meant for the commands
// after it, but only when the command redirects no input of its own: then
// its redirections are applied to the shell's input as it was, and
// `cat <&0 &` reads what the shell would have read.
import type { AndOr, Redirect } from "./ast";
import { literalText } from "./parser";

/**
 * True when `redirect` is one of the redirections bash counts as the
 * command's own input (redir.c stdin_redirection): any `<`, `<>`, here
 * document or here string, whatever fd it names (`cat 3< file &` keeps the
 * shell's input too), and a copy or a close of fd 0 (`<&N`, `0<&N`, `<&-`,
 * `0>&-`). Writing fd 0 elsewhere (`0> file`, `0>&N`) is not.
 */
function redirectsInput(redirect: Redirect): boolean {
  switch (redirect.op) {
    case "<":
    case "<>":
    case "<<":
    case "<<-":
    case "<<<":
      return true;
    case "<&":
      return (redirect.fd ?? 0) === 0;
    case ">&":
      return redirect.fd === 0 && literalText(redirect.target) === "-";
    default:
      return false;
  }
}

/**
 * True when background `andOr` gets /dev/null as its standard input, in a
 * shell without job control. bash makes two exceptions: a pipeline of
 * several commands, whose first command keeps the shell's input, and a lone
 * command that redirects its input itself. Only the redirections of that
 * command count: in `cat <&0 && true &` the list as a whole reads /dev/null,
 * which cat's `<&0` then copies.
 */
export function backgroundReadsNull(andOr: AndOr): boolean {
  if (andOr.rest.length > 0) {
    return true;
  }
  const { commands } = andOr.first;
  if (commands.length > 1) {
    return false;
  }
  const command = commands[0];
  return !("redirects" in command && command.redirects.some(redirectsInput));
}
