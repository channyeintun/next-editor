import { createRequire } from "node:module";

/**
 * What hubRules.test.ts measures in a hub's source, and the problems it reports. It lives
 * apart from the test so a changed copy of a hub can be measured the same way. It parses
 * with Babel, which the app already depends on, so what it counts is code, not text:
 * comments and blank lines never count, and nothing depends on how a line is wrapped
 * beyond the formatter.
 */

interface SourceLocation {
  start: { line: number };
  end: { line: number };
}

interface Node {
  type: string;
  loc: SourceLocation;
  [key: string]: unknown;
}

interface Token {
  type: string | { label: string };
  loc: SourceLocation;
}

interface ParsedFile {
  program: Node;
  tokens: Token[];
}

// @babel/core ships no type declarations; this is the one call these rules make.
const require = createRequire(import.meta.url);
const babel = require("@babel/core") as {
  parseSync: (code: string, options: Record<string, unknown>) => ParsedFile;
};

function parse(source: string): ParsedFile {
  return babel.parseSync(source, {
    filename: "hub.ts",
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript"], tokens: true },
  });
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === "loc" || key.endsWith("Comments")) return [];
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

// Getters and setters are methods of these types too, with `kind` "get" or "set".
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const METHOD_TYPES = new Set(["ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);

// Class fields that hold a value: an arrow in one is named after the field.
const FIELD_TYPES = new Set([
  "ObjectProperty",
  "ClassProperty",
  "ClassPrivateProperty",
  "ClassAccessorProperty",
]);

function keyName(key: unknown): string | null {
  if (!isNode(key)) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "PrivateName") {
    const id = keyName(key.id);
    return id === null ? null : `#${id}`;
  }
  return null;
}

// The name a reader would look for: the function's own, or the property or variable
// that holds it (an arrow passed to assign() inside `actions.foo` is "foo").
function nameOf(node: Node, inherited: string): string {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    const own = keyName(node.id);
    if (own) return own;
  }
  if (METHOD_TYPES.has(node.type)) return keyName(node.key) ?? inherited;
  return inherited;
}

function namedScope(node: Node, inherited: string): string {
  if (FIELD_TYPES.has(node.type)) return keyName(node.key) ?? inherited;
  if (node.type === "VariableDeclarator") return keyName(node.id) ?? inherited;
  return inherited;
}

/** One function and how many lines of code its body spans. */
export interface FunctionLength {
  name: string;
  line: number;
  lines: number;
}

/**
 * Every outermost function in the source with the number of lines its body spans that
 * hold code (the braces count, comments and blank lines do not). Functions nested in
 * another are part of its body: when the outer one is short, so are they.
 */
export function functionLengths(source: string): FunctionLength[] {
  const { program, tokens } = parse(source);
  const codeLines = new Set<number>();
  for (const token of tokens) {
    const label = typeof token.type === "string" ? token.type : token.type.label;
    if (label === "CommentLine" || label === "CommentBlock" || label === "eof") continue;
    for (let line = token.loc.start.line; line <= token.loc.end.line; line++) codeLines.add(line);
  }
  const linesOfCode = (loc: SourceLocation) => {
    let count = 0;
    for (let line = loc.start.line; line <= loc.end.line; line++) {
      if (codeLines.has(line)) count++;
    }
    return count;
  };

  const found: FunctionLength[] = [];
  const visit = (node: Node, inherited: string) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const body = node.body as Node;
      found.push({
        name: nameOf(node, inherited),
        line: node.loc.start.line,
        lines: linesOfCode(body.loc),
      });
      return;
    }
    const scope = namedScope(node, inherited);
    for (const child of children(node)) visit(child, scope);
  };
  visit(program, "(anonymous)");
  return found;
}

function topLevelDeclarations(program: Node): Node[] {
  return (program.body as Node[]).map((statement) =>
    statement.type === "ExportNamedDeclaration" && isNode(statement.declaration)
      ? statement.declaration
      : statement,
  );
}

const TYPE_DECLARATIONS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration"]);

/** How many top-level `interface` and `type` declarations the source holds, exported or not. */
export function typeDeclarationCount(source: string): number {
  return topLevelDeclarations(parse(source).program).filter((node) =>
    TYPE_DECLARATIONS.has(node.type),
  ).length;
}

function containsTypeLiteral(node: Node): boolean {
  return node.type === "TSTypeLiteral" || children(node).some(containsTypeLiteral);
}

/**
 * The lines of every object type written inline in the union `unionName`, following
 * the source's own union aliases it is built from (`type A = B | C`, where B is itself
 * a union, is read through B). A member that names a type declared elsewhere passes.
 */
export function inlineUnionMembers(source: string, unionName: string): number[] {
  const aliases = new Map<string, Node>();
  for (const node of topLevelDeclarations(parse(source).program)) {
    if (node.type === "TSTypeAliasDeclaration") aliases.set(keyName(node.id) ?? "", node);
  }
  const root = aliases.get(unionName);
  if (!root) throw new Error(`no type alias named ${unionName}`);

  const offenders: number[] = [];
  const seen = new Set<string>();
  const readUnion = (alias: Node) => {
    const annotation = alias.typeAnnotation as Node;
    const members = annotation.type === "TSUnionType" ? (annotation.types as Node[]) : [annotation];
    for (const member of members) {
      const referenced =
        member.type === "TSTypeReference" && !member.typeParameters
          ? aliases.get(keyName(member.typeName) ?? "")
          : undefined;
      const referencedName = referenced ? keyName(referenced.id) : null;
      if (referenced && referencedName && isUnionAlias(referenced)) {
        if (!seen.has(referencedName)) {
          seen.add(referencedName);
          readUnion(referenced);
        }
      } else if (containsTypeLiteral(member)) {
        offenders.push(member.loc.start.line);
      }
    }
  };
  seen.add(unionName);
  readUnion(root);
  return offenders;
}

function isUnionAlias(alias: Node): boolean {
  return (alias.typeAnnotation as Node).type === "TSUnionType";
}

/** The most lines of code a function in editorMachine.ts may hold. */
export const MAX_FUNCTION_LINES = 10;

export const WHERE_A_BODY_BELONGS =
  `a function in editorMachine.ts holds at most ${MAX_FUNCTION_LINES} lines of code: ` +
  "write its body in its domain's module (as playbackActors.ts, captureActions.ts and " +
  "replayActions.ts do) and register it in the machine with one line";

export function longFunctionProblems(source: string, allowed: Record<string, number>): string[] {
  const long = functionLengths(source).filter((fn) => fn.lines > MAX_FUNCTION_LINES);
  const problems = long.flatMap(({ name, line, lines }) => {
    const ceiling = allowed[name];
    if (ceiling === undefined) {
      return [`${name} (line ${line}) is ${lines} lines; ${WHERE_A_BODY_BELONGS}`];
    }
    if (long.filter((other) => other.name === name).length > 1) {
      return [
        `${name} (line ${line}) is ${lines} lines and shares its name with another long function; ${WHERE_A_BODY_BELONGS}`,
      ];
    }
    if (lines > ceiling) {
      return [
        `${name} (line ${line}) grew to ${lines} lines (listed at ${ceiling}); ${WHERE_A_BODY_BELONGS}`,
      ];
    }
    if (lines < ceiling) {
      return [
        `${name} is now ${lines} lines; lower its entry in LONG_FUNCTIONS (hubRules.test.ts) to ${lines}`,
      ];
    }
    return [];
  });
  const stale = Object.keys(allowed)
    .filter((name) => !long.some((fn) => fn.name === name))
    .map(
      (name) =>
        `${name} is now ${MAX_FUNCTION_LINES} lines or fewer, or is gone; remove it from LONG_FUNCTIONS (hubRules.test.ts)`,
    );
  return [...problems, ...stale];
}

/** The top-level statement that declares `name`, as `const name = …` or `export const name = …`. */
function declarationOf(program: Node, name: string): Node | undefined {
  return topLevelDeclarations(program).find(
    (node) =>
      node.type === "VariableDeclaration" &&
      (node.declarations as Node[]).some((declarator) => keyName(declarator.id) === name),
  );
}

/**
 * The lines of code of every function outside the declaration of `machineName`: the
 * hub's own helpers, which the 10-line cap alone lets grow as many short siblings.
 */
export function linesOutsideMachine(source: string, machineName: string): number {
  const machine = declarationOf(parse(source).program, machineName);
  if (!machine) throw new Error(`no top-level declaration of ${machineName}`);
  const { start, end } = machine.loc;
  return functionLengths(source)
    .filter((fn) => fn.line < start.line || fn.line > end.line)
    .reduce((total, fn) => total + fn.lines, 0);
}

/**
 * What editorMachine.ts may hold besides the machine: its helpers' lines of code only
 * go down, and it declares no type of its own (a domain's types live in its module).
 */
export function machineHelperProblems(source: string, ceiling: number): string[] {
  const problems: string[] = [];
  const lines = linesOutsideMachine(source, "editorMachine");
  if (lines > ceiling) {
    problems.push(
      `editorMachine.ts has ${lines} lines of code in functions outside the machine, more ` +
        `than ${ceiling}: write the helper in its domain's module and import it`,
    );
  }
  if (lines < ceiling) {
    problems.push(
      `editorMachine.ts has ${lines} lines of code in functions outside the machine; lower ` +
        `MACHINE_HELPER_LINES (hubRules.test.ts) to ${lines}`,
    );
  }
  const types = typeDeclarationCount(source);
  if (types > 0) {
    problems.push(
      `editorMachine.ts declares ${types} top-level interface or type declarations: declare ` +
        "them in the module of the domain they belong to and import them",
    );
  }
  return problems;
}

export function machineTypeProblems(source: string, ceiling: number): string[] {
  const problems: string[] = [];
  const count = typeDeclarationCount(source);
  if (count > ceiling) {
    problems.push(
      `machine/types.ts has ${count} top-level interface and type declarations, more than ` +
        `${ceiling}: declare a domain's events and context slice in its own module and import ` +
        "them, as types.ts does from learnerWorkspace.ts and viewerPanels.ts",
    );
  }
  if (count < ceiling) {
    problems.push(
      `machine/types.ts has ${count} top-level interface and type declarations; lower ` +
        `MACHINE_TYPE_DECLARATIONS (hubRules.test.ts) to ${count}`,
    );
  }
  for (const line of inlineUnionMembers(source, "EditorMachineEvent")) {
    problems.push(
      `machine/types.ts:${line} writes an event's object type inline in EditorMachineEvent: ` +
        "export the event type from its domain's module and name it in the union",
    );
  }
  return problems;
}
