// The shell's syntax tree: words (made of quoted and expandable parts),
// commands, redirections and the compound forms. The parser builds it; the
// expander and the interpreter walk it.

/** One piece of a word, before expansion. */
export type WordPart =
  /** Unquoted text: subject to brace expansion, field splitting results, globbing. */
  | { type: "lit"; value: string }
  /** Quoted text (`'…'`, `$'…'`, a backslash-escaped character): taken literally. */
  | { type: "sq"; value: string }
  /** A double-quoted span. */
  | { type: "dq"; parts: WordPart[] }
  /** `$name`, `${name…}`. */
  | ParamPart
  /** `$(…)` or a backtick substitution. */
  | { type: "cmdsub"; program: Program }
  /** `$((…))`; the parts expand to the expression text. */
  | { type: "arith"; parts: WordPart[] };

/** A parameter expansion. `op` is the operator after the name, if any. */
export interface ParamPart {
  type: "param";
  name: string;
  /** `${#name}`. */
  length?: boolean;
  /** `${!name}`: the variable whose name is the value of `name`. */
  indirect?: boolean;
  /** `:-` `-` `:=` `=` `:+` `+` `:?` `?` `%` `%%` `#` `##` `/` `//` `:` (substring) `^^` `,,` `^` `,`. */
  op?: string;
  /** The word after the operator (the pattern for `/`). */
  word?: Word;
  /** The replacement for `/` and `//`; the length for `:` substring. */
  word2?: Word;
}

export interface Word {
  parts: WordPart[];
}

export interface Assignment {
  name: string;
  value: Word;
  /** `name+=value`. */
  append: boolean;
}

export type RedirOp =
  | "<"
  | ">"
  | ">>"
  | ">|"
  | "<>"
  | "<&"
  | ">&"
  | "&>"
  | "&>>"
  | "<<"
  | "<<-"
  | "<<<";

export interface Redirect {
  /** The fd being redirected; undefined means the operator's default. */
  fd?: number;
  op: RedirOp;
  target: Word;
  /** Filled for `<<` / `<<-` when the body has been read. */
  heredoc?: HereDoc;
}

export interface HereDoc {
  /** The body: literal when the delimiter was quoted, else expandable parts. */
  body: Word;
  quoted: boolean;
}

export interface SimpleCommand {
  type: "simple";
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
  line: number;
}

export interface Subshell {
  type: "subshell";
  body: List;
  redirects: Redirect[];
}

export interface Group {
  type: "group";
  body: List;
  redirects: Redirect[];
}

export interface If {
  type: "if";
  clauses: { condition: List; body: List }[];
  elseBody?: List;
  redirects: Redirect[];
}

export interface For {
  type: "for";
  variable: string;
  /** Undefined means `"$@"`. */
  items?: Word[];
  body: List;
  redirects: Redirect[];
}

export interface ArithFor {
  type: "arithfor";
  init: string;
  test: string;
  update: string;
  body: List;
  redirects: Redirect[];
}

export interface While {
  type: "while";
  until: boolean;
  condition: List;
  body: List;
  redirects: Redirect[];
}

export interface CaseItem {
  patterns: Word[];
  body: List;
  /** `;;`, `;&` (fall through) or `;;&` (keep testing). */
  terminator: ";;" | ";&" | ";;&";
}

export interface Case {
  type: "case";
  subject: Word;
  items: CaseItem[];
  redirects: Redirect[];
}

export interface FunctionDef {
  type: "function";
  name: string;
  body: Command;
}

/** `[[ … ]]`. */
export interface CondCommand {
  type: "cond";
  expr: CondExpr;
  redirects: Redirect[];
}

/** `(( … ))`. */
export interface ArithCommand {
  type: "arithcmd";
  expr: Word;
  redirects: Redirect[];
}

export type CondExpr =
  | { type: "and" | "or"; left: CondExpr; right: CondExpr }
  | { type: "not"; expr: CondExpr }
  | { type: "unary"; op: string; arg: Word }
  | { type: "binary"; op: string; left: Word; right: Word }
  | { type: "word"; word: Word };

export type Command =
  | SimpleCommand
  | Subshell
  | Group
  | If
  | For
  | ArithFor
  | While
  | Case
  | FunctionDef
  | CondCommand
  | ArithCommand;

export interface Pipeline {
  negated: boolean;
  /** `stderrToo[i]` is true when command i is joined to the next with `|&`. */
  commands: Command[];
  stderrToo: boolean[];
}

/** Pipelines joined with `&&` / `||`. */
export interface AndOr {
  first: Pipeline;
  rest: { op: "&&" | "||"; pipeline: Pipeline }[];
}

export interface ListItem {
  andOr: AndOr;
  background: boolean;
  /** For a background item: its text as written, which `jobs` shows. */
  source?: string;
}

export interface List {
  items: ListItem[];
}

export type Program = List;
