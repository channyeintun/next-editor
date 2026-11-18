// The shell's parser: a recursive-descent parser over the lexer's tokens that
// builds the syntax tree in ast.ts. `parse` reads a whole program; a syntax
// error that more input could fix is marked `incomplete` so the interactive
// shell can ask for a continuation line.
import type {
  AndOr,
  Assignment,
  Case,
  CaseItem,
  Command,
  CondExpr,
  HereDoc,
  List,
  ListItem,
  Pipeline,
  Program,
  Redirect,
  SimpleCommand,
  Word,
} from "./ast";
import { Lexer, ShellSyntaxError, parseArithText } from "./lexer";
import type { Token } from "./lexer";

const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "case",
  "esac",
  "while",
  "until",
  "for",
  "in",
  "{",
  "}",
  "!",
  "[[",
  "]]",
  "function",
  "select",
]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;

/** Parses a whole program. Throws `ShellSyntaxError`. */
export function parse(source: string): Program {
  const parser = new Parser(createLexer(source, 0, 1));
  const program = parser.parseProgram();
  return program;
}

/** The plain text of a word made only of unquoted literal text, else null. */
export function literalText(word: Word): string | null {
  if (word.parts.length === 1 && word.parts[0].type === "lit") {
    return word.parts[0].value;
  }
  return null;
}

function createLexer(source: string, pos: number, line: number): Lexer {
  return new Lexer(source, parseSubstitution, parse, pos, line);
}

function parseSubstitution(
  source: string,
  pos: number,
  line: number,
): { program: Program; end: number; line: number } {
  const lexer = createLexer(source, pos, line);
  const parser = new Parser(lexer);
  const program = parser.parseList([")"]);
  const close = parser.take();
  if (close.type !== "op" || close.value !== ")") {
    if (close.type === "eof") {
      throw new ShellSyntaxError("unexpected end of input while looking for matching `)'", true);
    }
    throw new ShellSyntaxError(`syntax error near unexpected token \`${describe(close)}'`);
  }
  return { program, end: lexer.pos, line: lexer.line };
}

function describe(token: Token): string {
  switch (token.type) {
    case "word":
      return token.raw;
    case "op":
      return token.value === "\n" ? "newline" : token.value;
    case "redir":
      return token.op;
    case "eof":
      return "end of file";
  }
}

class Parser {
  readonly lexer: Lexer;
  private lookahead: Token | null = null;
  /** Where `lookahead` starts in the source. */
  private lookaheadStart = 0;

  constructor(lexer: Lexer) {
    this.lexer = lexer;
  }

  peek(): Token {
    if (!this.lookahead) {
      this.lookahead = this.lexer.next();
      this.lookaheadStart = this.lexer.tokenStart;
    }
    return this.lookahead;
  }

  take(): Token {
    const token = this.peek();
    this.lookahead = null;
    return token;
  }

  private isOp(token: Token, value: string): boolean {
    return token.type === "op" && token.value === value;
  }

  private isKeyword(token: Token, keyword: string): boolean {
    return token.type === "word" && literalText(token.word) === keyword;
  }

  private fail(token: Token): never {
    if (token.type === "eof") {
      throw new ShellSyntaxError("syntax error: unexpected end of file", true);
    }
    throw new ShellSyntaxError(`syntax error near unexpected token \`${describe(token)}'`);
  }

  private skipNewlines(): void {
    while (this.isOp(this.peek(), "\n")) {
      this.take();
    }
  }

  private expectKeyword(keyword: string): void {
    this.skipNewlines();
    const token = this.take();
    if (!this.isKeyword(token, keyword)) {
      this.fail(token);
    }
  }

  parseProgram(): Program {
    const list = this.parseList([]);
    const token = this.peek();
    if (token.type !== "eof") {
      this.fail(token);
    }
    return list;
  }

  /** True when `token` ends a list: one of `stops` (keywords or operators) or end of file. */
  private atListEnd(token: Token, stops: string[]): boolean {
    if (token.type === "eof") {
      return true;
    }
    if (token.type === "op") {
      return (
        stops.includes(token.value) ||
        token.value === ";;" ||
        token.value === ";&" ||
        token.value === ";;&"
      );
    }
    if (token.type === "word") {
      const text = literalText(token.word);
      return text !== null && stops.includes(text);
    }
    return false;
  }

  /** A list of and-or lists separated by `;`, `&` or newlines, up to one of `stops`. */
  parseList(stops: string[]): List {
    const items: ListItem[] = [];
    this.skipNewlines();
    while (!this.atListEnd(this.peek(), stops)) {
      const start = this.lookaheadStart;
      const andOr = this.parseAndOr();
      const sep = this.peek();
      if (this.isOp(sep, "&")) {
        // A job is shown (`jobs`) as it was written, as bash does.
        const source = this.lexer.source.slice(start, this.lookaheadStart).trim();
        this.take();
        items.push({ andOr, background: true, source });
      } else {
        if (this.isOp(sep, ";") || this.isOp(sep, "\n")) {
          this.take();
        } else if (!this.atListEnd(sep, stops)) {
          this.fail(sep);
        }
        items.push({ andOr, background: false });
      }
      this.skipNewlines();
    }
    return { items };
  }

  /** A list that must not be empty (the body of `if`, `while`, …). */
  private parseCompoundList(stops: string[]): List {
    const list = this.parseList(stops);
    if (list.items.length === 0) {
      this.fail(this.peek());
    }
    return list;
  }

  private parseAndOr(): AndOr {
    const first = this.parsePipeline();
    const rest: AndOr["rest"] = [];
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, "&&") || this.isOp(token, "||")) {
        this.take();
        this.skipNewlines();
        rest.push({ op: (token as { value: "&&" | "||" }).value, pipeline: this.parsePipeline() });
      } else {
        return { first, rest };
      }
    }
  }

  private parsePipeline(): Pipeline {
    let negated = false;
    while (this.isKeyword(this.peek(), "!")) {
      this.take();
      negated = !negated;
    }
    const commands = [this.parseCommand()];
    const stderrToo: boolean[] = [];
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, "|") || this.isOp(token, "|&")) {
        this.take();
        stderrToo.push(this.isOp(token, "|&"));
        this.skipNewlines();
        commands.push(this.parseCommand());
      } else {
        return { negated, commands, stderrToo };
      }
    }
  }

  private parseCommand(): Command {
    const token = this.peek();
    if (token.type === "eof") {
      this.fail(token);
    }
    if (this.isOp(token, "(")) {
      this.take();
      // `((` starts arithmetic only when the two parens touch; `( (` is a
      // nested subshell.
      if (this.isOp(this.peek(), "(") && this.lexer.source[this.lexer.pos - 2] === "(") {
        const arith = this.parseArithCommand();
        if (arith) {
          return arith;
        }
      }
      const body = this.parseCompoundList([")"]);
      const close = this.take();
      if (!this.isOp(close, ")")) {
        this.fail(close);
      }
      return { type: "subshell", body, redirects: this.parseRedirects() };
    }
    if (token.type === "word") {
      const text = literalText(token.word);
      switch (text) {
        case "{": {
          this.take();
          const body = this.parseCompoundList(["}"]);
          this.expectKeyword("}");
          return { type: "group", body, redirects: this.parseRedirects() };
        }
        case "if":
          return this.parseIf();
        case "while":
        case "until":
          return this.parseWhile(text === "until");
        case "for":
          return this.parseFor();
        case "case":
          return this.parseCase();
        case "[[":
          return this.parseCond();
        case "function":
          return this.parseFunctionKeyword();
        case "select":
          throw new ShellSyntaxError("sh: select: not supported");
        case "then":
        case "else":
        case "elif":
        case "fi":
        case "do":
        case "done":
        case "esac":
        case "}":
        case "in":
        case "]]":
          this.fail(token);
      }
    }
    return this.parseSimpleOrFunction();
  }

  /**
   * `((…))`, or null when the text is not one (`((echo a); echo b)`), which
   * bash then reads as nested subshells.
   */
  private parseArithCommand(): Command | null {
    // We have taken `(` and peeked `(`: read raw text up to `))`.
    const source = this.lexer.source;
    let pos = this.lexer.pos;
    let depth = 0;
    for (; pos < source.length; pos++) {
      const c = source[pos];
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        if (depth === 0) {
          break;
        }
        depth--;
      }
    }
    if (pos >= source.length) {
      throw new ShellSyntaxError("unexpected end of input while looking for `))'", true);
    }
    if (source[pos + 1] !== ")") {
      return null;
    }
    this.lookahead = null;
    const text = source.slice(this.lexer.pos, pos);
    this.lexer.pos = pos + 2;
    return {
      type: "arithcmd",
      expr: { parts: parseArithText(text, parseSubstitution, parse) },
      redirects: this.parseRedirects(),
    };
  }

  private parseIf(): Command {
    this.take();
    const clauses: { condition: List; body: List }[] = [];
    const condition = this.parseCompoundList(["then"]);
    this.expectKeyword("then");
    const body = this.parseCompoundList(["elif", "else", "fi"]);
    clauses.push({ condition, body });
    let elseBody: List | undefined;
    for (;;) {
      const token = this.take();
      if (this.isKeyword(token, "elif")) {
        const c = this.parseCompoundList(["then"]);
        this.expectKeyword("then");
        const b = this.parseCompoundList(["elif", "else", "fi"]);
        clauses.push({ condition: c, body: b });
      } else if (this.isKeyword(token, "else")) {
        elseBody = this.parseCompoundList(["fi"]);
        this.expectKeyword("fi");
        break;
      } else if (this.isKeyword(token, "fi")) {
        break;
      } else {
        this.fail(token);
      }
    }
    return { type: "if", clauses, elseBody, redirects: this.parseRedirects() };
  }

  private parseWhile(until: boolean): Command {
    this.take();
    const condition = this.parseCompoundList(["do"]);
    this.expectKeyword("do");
    const body = this.parseCompoundList(["done"]);
    this.expectKeyword("done");
    return { type: "while", until, condition, body, redirects: this.parseRedirects() };
  }

  private parseDoGroup(): List {
    this.skipNewlines();
    const token = this.take();
    if (this.isKeyword(token, "do")) {
      const body = this.parseCompoundList(["done"]);
      this.expectKeyword("done");
      return body;
    }
    if (this.isKeyword(token, "{")) {
      const body = this.parseCompoundList(["}"]);
      this.expectKeyword("}");
      return body;
    }
    return this.fail(token);
  }

  private parseFor(): Command {
    this.take();
    if (this.isOp(this.peek(), "(")) {
      return this.parseArithFor();
    }
    const nameToken = this.take();
    const name = nameToken.type === "word" ? literalText(nameToken.word) : null;
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ShellSyntaxError(`\`${describe(nameToken)}': not a valid identifier`);
    }
    let items: Word[] | undefined;
    const next = this.peek();
    if (this.isOp(next, ";")) {
      this.take();
    } else {
      this.skipNewlines();
      if (this.isKeyword(this.peek(), "in")) {
        this.take();
        items = [];
        while (this.peek().type === "word") {
          items.push((this.take() as { word: Word }).word);
        }
        const sep = this.take();
        if (!this.isOp(sep, ";") && !this.isOp(sep, "\n")) {
          this.fail(sep);
        }
      }
    }
    const body = this.parseDoGroup();
    return { type: "for", variable: name, items, body, redirects: this.parseRedirects() };
  }

  private parseArithFor(): Command {
    this.take(); // (
    const source = this.lexer.source;
    if (source[this.lexer.pos] !== "(") {
      throw new ShellSyntaxError("syntax error: expected `((' after `for'");
    }
    let pos = this.lexer.pos + 1;
    let depth = 0;
    for (; pos < source.length; pos++) {
      const c = source[pos];
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        if (depth === 0) {
          break;
        }
        depth--;
      }
    }
    if (pos >= source.length || source[pos + 1] !== ")") {
      throw new ShellSyntaxError("unexpected end of input while looking for `))'", true);
    }
    const text = source.slice(this.lexer.pos + 1, pos);
    this.lexer.pos = pos + 2;
    const sections = text.split(";");
    if (sections.length !== 3) {
      throw new ShellSyntaxError(
        "syntax error: `for ((init; test; update))' needs three expressions",
      );
    }
    if (this.isOp(this.peek(), ";")) {
      this.take();
    }
    const body = this.parseDoGroup();
    return {
      type: "arithfor",
      init: sections[0],
      test: sections[1],
      update: sections[2],
      body,
      redirects: this.parseRedirects(),
    };
  }

  private parseCase(): Case {
    this.take();
    const subjectToken = this.take();
    if (subjectToken.type !== "word") {
      this.fail(subjectToken);
    }
    this.expectKeyword("in");
    const items: CaseItem[] = [];
    for (;;) {
      this.skipNewlines();
      let token = this.peek();
      if (this.isKeyword(token, "esac")) {
        this.take();
        break;
      }
      if (this.isOp(token, "(")) {
        this.take();
        token = this.peek();
      }
      const patterns: Word[] = [];
      for (;;) {
        const pattern = this.take();
        if (pattern.type !== "word") {
          this.fail(pattern);
        }
        patterns.push(pattern.word);
        const sep = this.take();
        if (this.isOp(sep, ")")) {
          break;
        }
        if (!this.isOp(sep, "|")) {
          this.fail(sep);
        }
      }
      const body = this.parseList(["esac"]);
      const end = this.peek();
      let terminator: CaseItem["terminator"] = ";;";
      if (end.type === "op" && (end.value === ";;" || end.value === ";&" || end.value === ";;&")) {
        terminator = end.value;
        this.take();
        items.push({ patterns, body, terminator });
        continue;
      }
      items.push({ patterns, body, terminator });
      this.skipNewlines();
      const close = this.take();
      if (!this.isKeyword(close, "esac")) {
        this.fail(close);
      }
      break;
    }
    return { type: "case", subject: subjectToken.word, items, redirects: this.parseRedirects() };
  }

  private parseCond(): Command {
    this.take();
    const expr = this.parseCondOr();
    const close = this.take();
    if (!this.isKeyword(close, "]]")) {
      this.fail(close);
    }
    return { type: "cond", expr, redirects: this.parseRedirects() };
  }

  private parseCondOr(): CondExpr {
    let left = this.parseCondAnd();
    while (this.isOp(this.peek(), "||")) {
      this.take();
      this.skipNewlines();
      left = { type: "or", left, right: this.parseCondAnd() };
    }
    return left;
  }

  private parseCondAnd(): CondExpr {
    let left = this.parseCondNot();
    while (this.isOp(this.peek(), "&&")) {
      this.take();
      this.skipNewlines();
      left = { type: "and", left, right: this.parseCondNot() };
    }
    return left;
  }

  private parseCondNot(): CondExpr {
    if (this.isKeyword(this.peek(), "!")) {
      this.take();
      return { type: "not", expr: this.parseCondNot() };
    }
    return this.parseCondPrimary();
  }

  private condWord(): Word {
    const token = this.take();
    if (token.type !== "word" || this.isKeyword(token, "]]")) {
      return this.fail(token);
    }
    return token.word;
  }

  private parseCondPrimary(): CondExpr {
    const token = this.peek();
    if (this.isOp(token, "(")) {
      this.take();
      const inner = this.parseCondOr();
      const close = this.take();
      if (!this.isOp(close, ")")) {
        this.fail(close);
      }
      return inner;
    }
    const first = this.condWord();
    const firstText = literalText(first);
    if (firstText && /^-[a-zA-Z]$/.test(firstText)) {
      const next = this.peek();
      if (next.type === "word" && !this.isKeyword(next, "]]")) {
        return { type: "unary", op: firstText, arg: this.condWord() };
      }
    }
    const opToken = this.peek();
    let op: string | null = null;
    if (opToken.type === "word") {
      const text = literalText(opToken.word);
      if (
        text !== null &&
        [
          "==",
          "=",
          "!=",
          "=~",
          "-eq",
          "-ne",
          "-lt",
          "-le",
          "-gt",
          "-ge",
          "-nt",
          "-ot",
          "-ef",
        ].includes(text)
      ) {
        op = text;
      }
    } else if (
      opToken.type === "redir" &&
      (opToken.op === "<" || opToken.op === ">") &&
      opToken.fd === undefined
    ) {
      op = opToken.op;
    }
    if (op === null) {
      return { type: "word", word: first };
    }
    this.lookahead = null;
    if (op === "=~") {
      const right = this.lexer.readRegexWord();
      if (right.type !== "word" || right.word.parts.length === 0) {
        this.fail(right);
      }
      return { type: "binary", op, left: first, right: right.word };
    }
    return { type: "binary", op, left: first, right: this.condWord() };
  }

  private parseFunctionKeyword(): Command {
    this.take();
    const nameToken = this.take();
    if (nameToken.type !== "word") {
      this.fail(nameToken);
    }
    const name = nameToken.raw;
    if (this.isOp(this.peek(), "(")) {
      this.take();
      const close = this.take();
      if (!this.isOp(close, ")")) {
        this.fail(close);
      }
    }
    this.skipNewlines();
    return { type: "function", name, body: this.parseCommand() };
  }

  private parseRedirects(): Redirect[] {
    const redirects: Redirect[] = [];
    while (this.peek().type === "redir") {
      redirects.push(this.parseRedirect());
    }
    return redirects;
  }

  private parseRedirect(): Redirect {
    const token = this.take() as Extract<Token, { type: "redir" }>;
    const target = this.take();
    if (target.type !== "word") {
      return this.fail(target);
    }
    const redirect: Redirect = { fd: token.fd, op: token.op, target: target.word };
    if (token.op === "<<" || token.op === "<<-") {
      const quoted = target.word.parts.some((part) => part.type !== "lit");
      const delimiter = target.word.parts
        .map((part) => {
          if (part.type === "lit" || part.type === "sq") {
            return part.value;
          }
          if (part.type === "dq") {
            return part.parts
              .map((p) => (p.type === "sq" || p.type === "lit" ? p.value : ""))
              .join("");
          }
          return "";
        })
        .join("");
      const heredoc: HereDoc = { body: { parts: [] }, quoted };
      redirect.heredoc = heredoc;
      this.lexer.addHereDoc(delimiter, token.op === "<<-", heredoc);
    }
    return redirect;
  }

  private parseSimpleOrFunction(): Command {
    const first = this.peek();
    // `name() compound-command`
    if (
      first.type === "word" &&
      /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(first.raw) &&
      literalText(first.word) !== null
    ) {
      this.take();
      if (this.isOp(this.peek(), "(")) {
        this.take();
        const close = this.take();
        if (!this.isOp(close, ")")) {
          this.fail(close);
        }
        this.skipNewlines();
        return { type: "function", name: first.raw, body: this.parseCommand() };
      }
      return this.parseSimple(first);
    }
    return this.parseSimple(null);
  }

  private parseSimple(firstWord: Extract<Token, { type: "word" }> | null): SimpleCommand {
    const command: SimpleCommand = {
      type: "simple",
      assignments: [],
      words: [],
      redirects: [],
      line: firstWord?.line ?? this.peek().line,
    };
    let pending: Token | null = firstWord;
    for (;;) {
      const token = pending ?? this.peek();
      if (token.type === "redir") {
        command.redirects.push(this.parseRedirect());
        continue;
      }
      if (token.type !== "word") {
        break;
      }
      if (pending) {
        pending = null;
      } else {
        this.take();
      }
      if (command.words.length === 0) {
        const assignment = toAssignment(token);
        if (assignment) {
          if (token.raw.endsWith("=") && this.isOp(this.peek(), "(")) {
            throw new ShellSyntaxError(`sh: ${assignment.name}=(…): arrays are not supported`);
          }
          command.assignments.push(assignment);
          continue;
        }
      }
      command.words.push(token.word);
    }
    if (
      command.words.length === 0 &&
      command.assignments.length === 0 &&
      command.redirects.length === 0
    ) {
      this.fail(this.peek());
    }
    return command;
  }
}

function toAssignment(token: Extract<Token, { type: "word" }>): Assignment | null {
  const first = token.word.parts[0];
  if (!first || first.type !== "lit") {
    return null;
  }
  const match = ASSIGNMENT.exec(first.value);
  if (!match) {
    return null;
  }
  const rest = first.value.slice(match[0].length);
  if (rest.startsWith("(") || (rest === "" && token.raw.slice(match[0].length).startsWith("("))) {
    throw new ShellSyntaxError(`sh: ${match[1]}: arrays not supported`);
  }
  const parts = token.word.parts.slice(1);
  if (rest) {
    parts.unshift({ type: "lit", value: rest });
  }
  return { name: match[1], value: { parts }, append: match[2] === "+" };
}

/** True when `name` is a reserved word. */
export function isReservedWord(name: string): boolean {
  return RESERVED.has(name);
}
