//! The rewrite itself: parse, resolve every reference to its binding, and edit
//! the source text in place. Nothing is printed from the tree: all that is not
//! an `import`, an `export` or a use of an imported name stays byte for byte.

use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ImportDeclarationSpecifier,
    ModuleExportName, Statement, StringLiteral,
};
use oxc_ast::AstKind;
use oxc_parser::Parser;
use oxc_semantic::{SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::{AssignmentOperator, UpdateOperator};

/// The names the rewritten code declares. A source that already uses the
/// prefix is declined, so none of them can meet a name of the module's own.
const PREFIX: &str = "__wnr_";

const REQUIRE: &str = "__webnode_require";
const EXPORTS: &str = "__webnode_exports";

// sucrase's helpers (HelperManager.js), under this rewriter's names.
const HELPER_WILDCARD: &str = " function __wnr_wildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { newObj[key] = obj[key]; } } } newObj.default = obj; return newObj; } }";
const HELPER_DEFAULT: &str = " function __wnr_default(obj) { return obj && obj.__esModule ? obj : { default: obj }; }";
const HELPER_FROM: &str = " function __wnr_from(obj, localName, importedName) { Object.defineProperty(__webnode_exports, localName, {enumerable: true, configurable: true, get: () => obj[importedName]}); }";
const HELPER_STAR: &str = " function __wnr_star(obj) { Object.keys(obj).filter((key) => key !== \"default\" && key !== \"__esModule\").forEach((key) => { if (__webnode_exports.hasOwnProperty(key)) { return; } Object.defineProperty(__webnode_exports, key, {enumerable: true, configurable: true, get: () => obj[key]}); }); }";

/// One change to the source: `text` in place of the bytes from `start` to `end`.
struct Edit {
    start: u32,
    end: u32,
    text: String,
}

/// What the module takes from one path, by all its `import` and
/// `export … from` statements together: sucrase makes one `require` of it.
#[derive(Default)]
struct PathUse<'a> {
    /// The path as the source spells it, quotes included.
    literal: &'a str,
    /// The local bindings of its default export (`import a`, `import { default as a }`).
    defaults: Vec<SymbolId>,
    /// The local names of its namespace (`import * as ns`).
    wildcards: Vec<&'a str>,
    /// Each named import: the name there, the binding here.
    named: Vec<(&'a str, SymbolId)>,
    /// Each `export { imported as exported } from`.
    named_exports: Vec<(&'a str, &'a str)>,
    /// Each `export * as name from`.
    star_names: Vec<&'a str>,
    /// `export * from`.
    star: bool,
    /// The code that stands for the first statement naming the path; taken once.
    code: Option<String>,
}

#[derive(Default)]
struct Helpers {
    wildcard: bool,
    default: bool,
    from: bool,
    star: bool,
}

fn decline<T>(why: &str) -> Result<T, String> {
    Err(why.to_string())
}

/// As many line breaks as `text` has: a statement replaced by one line keeps
/// every later line where it was.
fn lines_of(text: &str) -> String {
    "\n".repeat(text.bytes().filter(|&byte| byte == b'\n').count())
}

fn name_of<'a>(name: &ModuleExportName<'a>) -> Result<&'a str, String> {
    match name {
        ModuleExportName::IdentifierName(identifier) => Ok(identifier.name.as_str()),
        ModuleExportName::IdentifierReference(identifier) => Ok(identifier.name.as_str()),
        // The loader has already written every string name as an identifier.
        ModuleExportName::StringLiteral(_) => decline("a string for an import or export name"),
    }
}

/// The path a statement names; a string that is no text (a lone surrogate) is none.
fn path_of<'a>(literal: &StringLiteral<'a>) -> Result<&'a str, String> {
    match literal.value.as_str() {
        Some(value) => Ok(value),
        None => decline("a path that is not text"),
    }
}

/// The module `source` with its `import` and `export` statements rewritten, or
/// why this rewriter leaves it to sucrase.
pub fn rewrite(source: &str) -> Result<String, String> {
    if source.contains(PREFIX) {
        return decline("the source uses the rewriter's own names");
    }
    if u32::try_from(source.len()).is_err() {
        return decline("the source is too long");
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if parsed.diagnostics.has_errors() {
        return decline("the source does not parse as a module");
    }
    let program = parsed.program;
    // The node store, to see what each use of a name stands in; the checks, so
    // that only a module the engine would take is rewritten.
    let built = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .build(&program);
    if built.diagnostics.has_errors() {
        return decline("the module's bindings do not resolve");
    }
    let semantic = built.semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let text = |span: Span| &source[span.start as usize..span.end as usize];

    // What each path gives, in the order the paths first appear.
    let mut order: Vec<&str> = Vec::new();
    let mut paths: HashMap<&str, PathUse> = HashMap::new();
    let mut had_export = false;
    macro_rules! path {
        ($source:expr) => {{
            let value = path_of(&$source)?;
            if !paths.contains_key(value) {
                order.push(value);
                paths.insert(value, PathUse { literal: text($source.span), ..PathUse::default() });
            }
            paths.get_mut(value).unwrap()
        }};
    }
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if import.phase.is_some() {
                    return decline("an import with a phase");
                }
                let used = path!(import.source);
                for specifier in import.specifiers.iter().flatten() {
                    match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(named) => {
                            let imported = name_of(&named.imported)?;
                            let local = named.local.symbol_id();
                            if imported == "default" {
                                used.defaults.push(local);
                            } else {
                                used.named.push((imported, local));
                            }
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                            used.defaults.push(default.local.symbol_id());
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                            used.wildcards.push(namespace.local.name.as_str());
                        }
                    }
                }
            }
            Statement::ExportFromDeclaration(export) => {
                had_export = true;
                let used = path!(export.source);
                for specifier in &export.specifiers {
                    used.named_exports
                        .push((name_of(&specifier.local)?, name_of(&specifier.exported)?));
                }
            }
            Statement::ExportNamedDeclaration(_) | Statement::ExportDeclaration(_) => {
                had_export = true;
            }
            Statement::ExportAllDeclaration(export) => {
                had_export = true;
                let used = path!(export.source);
                match &export.exported {
                    Some(name) => used.star_names.push(name_of(name)?),
                    None => used.star = true,
                }
            }
            Statement::ExportDefaultDeclaration(_) => had_export = true,
            Statement::TSExportAssignment(_)
            | Statement::TSNamespaceExportDeclaration(_)
            | Statement::TSImportEqualsDeclaration(_) => {
                return decline("TypeScript module syntax");
            }
            _ => {}
        }
    }

    // sucrase's `generateImportReplacements`: the code for each path, and what
    // stands for each imported binding wherever the module uses it.
    let mut helpers = Helpers::default();
    let mut replacements: HashMap<SymbolId, String> = HashMap::new();
    for (index, value) in order.iter().enumerate() {
        let used = paths.get_mut(value).unwrap();
        let literal = used.literal;
        if used.defaults.is_empty()
            && used.wildcards.is_empty()
            && used.named.is_empty()
            && used.named_exports.is_empty()
            && used.star_names.is_empty()
            && !used.star
        {
            used.code = Some(format!("{REQUIRE}({literal});"));
            continue;
        }
        let primary = format!("{PREFIX}m{index}");
        let secondary = match used.wildcards.first() {
            Some(namespace) => (*namespace).to_string(),
            None => format!("{PREFIX}d{index}"),
        };
        let mut code = format!("var {primary} = {REQUIRE}({literal});");
        if !used.wildcards.is_empty() {
            helpers.wildcard = true;
            for namespace in &used.wildcards {
                code.push_str(&format!(" var {namespace} = {PREFIX}wildcard({primary});"));
            }
        } else if !used.star_names.is_empty() {
            helpers.wildcard = true;
            code.push_str(&format!(" var {secondary} = {PREFIX}wildcard({primary});"));
        } else if !used.defaults.is_empty() {
            helpers.default = true;
            code.push_str(&format!(" var {secondary} = {PREFIX}default({primary});"));
        }
        for (imported, exported) in &used.named_exports {
            helpers.from = true;
            code.push_str(&format!(" {PREFIX}from({primary}, '{exported}', '{imported}');"));
        }
        for name in &used.star_names {
            code.push_str(&format!(" {EXPORTS}.{name} = {secondary};"));
        }
        if used.star {
            helpers.star = true;
            code.push_str(&format!(" {PREFIX}star({primary});"));
        }
        for symbol in &used.defaults {
            replacements.insert(*symbol, format!("{secondary}.default"));
        }
        for (imported, symbol) in &used.named {
            replacements.insert(*symbol, format!("{primary}.{imported}"));
        }
        used.code = Some(code);
    }

    let mut edits: Vec<Edit> = Vec::new();
    // The statements replaced whole: a use of an imported name inside one is
    // written with the statement, not by itself.
    let mut replaced: Vec<Span> = Vec::new();
    // The module's own bindings it exports, each with a name it has outside: an
    // assignment to one must reach the export too.
    let mut exported: Vec<(SymbolId, &str)> = Vec::new();
    let claim = |paths: &mut HashMap<&str, PathUse>, value: &str, span: Span| -> Edit {
        let code = paths.get_mut(value).unwrap().code.take().unwrap_or_default();
        Edit { start: span.start, end: span.end, text: format!("{code}{}", lines_of(text(span))) }
    };
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                edits.push(claim(&mut paths, path_of(&import.source)?, import.span));
            }
            Statement::ExportAllDeclaration(export) => {
                edits.push(claim(&mut paths, path_of(&export.source)?, export.span));
            }
            Statement::ExportFromDeclaration(export) => {
                edits.push(claim(&mut paths, path_of(&export.source)?, export.span));
            }
            Statement::ExportDeclaration(export) => {
                {
                    let (inner, assignments) = match &export.declaration {
                        Declaration::VariableDeclaration(variables) => {
                            let mut assignments = String::from(";");
                            for declarator in &variables.declarations {
                                let BindingPattern::BindingIdentifier(binding) = &declarator.id
                                else {
                                    return decline("an exported destructuring declaration");
                                };
                                let name = binding.name.as_str();
                                exported.push((binding.symbol_id(), name));
                                assignments.push_str(&format!("{EXPORTS}.{name} = {name};"));
                            }
                            (variables.span, assignments)
                        }
                        Declaration::FunctionDeclaration(function) => {
                            let Some(binding) = &function.id else {
                                return decline("an exported function without a name");
                            };
                            let name = binding.name.as_str();
                            exported.push((binding.symbol_id(), name));
                            (function.span, format!(" {EXPORTS}.{name} = {name};"))
                        }
                        Declaration::ClassDeclaration(class) => {
                            let Some(binding) = &class.id else {
                                return decline("an exported class without a name");
                            };
                            let name = binding.name.as_str();
                            exported.push((binding.symbol_id(), name));
                            (class.span, format!(" {EXPORTS}.{name} = {name};"))
                        }
                        _ => return decline("an exported TypeScript declaration"),
                    };
                    edits.push(Edit {
                        start: export.span.start,
                        end: inner.start,
                        text: String::new(),
                    });
                    edits.push(Edit { start: inner.end, end: inner.end, text: assignments });
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                {
                    // `export { a, b as c }`: each as it stands where the statement is.
                    let mut code = String::new();
                    for specifier in &export.specifiers {
                        let ModuleExportName::IdentifierReference(local) = &specifier.local else {
                            return decline("an export of a name that is no binding");
                        };
                        let Some(symbol) = scoping.get_reference(local.reference_id()).symbol_id()
                        else {
                            return decline("an export of a name the module does not declare");
                        };
                        let outside = name_of(&specifier.exported)?;
                        let value = match replacements.get(&symbol) {
                            Some(replacement) => replacement.as_str(),
                            None => {
                                exported.push((symbol, outside));
                                local.name.as_str()
                            }
                        };
                        if !code.is_empty() {
                            code.push(' ');
                        }
                        code.push_str(&format!("{EXPORTS}.{outside} = {value};"));
                    }
                    code.push_str(&lines_of(text(export.span)));
                    replaced.push(export.span);
                    edits.push(Edit { start: export.span.start, end: export.span.end, text: code });
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let inner = export.declaration.span();
                let name = match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        function.id.as_ref().map(|binding| binding.name.as_str())
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        class.id.as_ref().map(|binding| binding.name.as_str())
                    }
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {
                        return decline("an exported TypeScript declaration");
                    }
                    _ => None,
                };
                let declares = matches!(
                    &export.declaration,
                    ExportDefaultDeclarationKind::FunctionDeclaration(_)
                        | ExportDefaultDeclarationKind::ClassDeclaration(_)
                );
                match name {
                    // A declaration of its own, then the export.
                    Some(name) => {
                        edits.push(Edit {
                            start: export.span.start,
                            end: inner.start,
                            text: String::new(),
                        });
                        edits.push(Edit {
                            start: inner.end,
                            end: inner.end,
                            text: format!(" {EXPORTS}.default = {name};"),
                        });
                    }
                    None => {
                        edits.push(Edit {
                            start: export.span.start,
                            end: inner.start,
                            text: format!("{EXPORTS}.default = "),
                        });
                        if declares {
                            // Now an expression: it must not run into the next line.
                            edits.push(Edit {
                                start: inner.end,
                                end: inner.end,
                                text: String::from(";"),
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Whether the code at `start` is the first on its line: what is put there
    // must not begin with a parenthesis, which would join the line before.
    let begins_line = |start: u32| {
        let before = source[..start as usize].trim_end_matches([' ', '\t']);
        before.is_empty() || before.ends_with('\n')
    };
    // An assignment to an exported binding assigns the export as well:
    // sucrase's `processAssignment`, `processComplexAssignment` and its two
    // for `++` and `--`. Any other way to assign one is not followed there
    // either; such a module is left to it.
    let mut outside: HashMap<SymbolId, Vec<&str>> = HashMap::new();
    for (symbol, name) in &exported {
        let names = outside.entry(*symbol).or_default();
        if !names.contains(name) {
            names.push(name);
        }
    }
    for (symbol, names) in &outside {
        let exports =
            names.iter().map(|name| format!("{EXPORTS}.{name}")).collect::<Vec<_>>().join(" = ");
        for reference in scoping.get_resolved_references(*symbol) {
            if !reference.is_write() {
                continue;
            }
            let node = reference.node_id();
            let span = nodes.kind(node).span();
            let name = text(span);
            match nodes.parent_kind(node) {
                AstKind::AssignmentExpression(assignment) if assignment.left.span() == span => {
                    if assignment.operator == AssignmentOperator::Assign {
                        // `a = v` becomes `a = exports.a = v`.
                        let at = assignment.right.span().start;
                        edits.push(Edit { start: at, end: at, text: format!("{exports} = ") });
                    } else {
                        // `a += v` becomes `a = exports.a += v`.
                        edits.push(Edit {
                            start: span.end,
                            end: span.end,
                            text: format!(" = {exports}"),
                        });
                    }
                }
                AstKind::UpdateExpression(update) if update.argument.span() == span => {
                    let whole = update.span;
                    let statement =
                        matches!(nodes.parent_kind(nodes.parent_id(node)), AstKind::ExpressionStatement(_));
                    if !statement && begins_line(whole.start) {
                        return decline("an exported binding is counted up at the start of a line");
                    }
                    let (open, close) = if statement { ("", "") } else { ("(", ")") };
                    let step = match update.operator {
                        UpdateOperator::Increment => ('+', '-'),
                        UpdateOperator::Decrement => ('-', '+'),
                    };
                    if update.prefix {
                        // `++a` becomes `exports.a = ++a`.
                        edits.push(Edit {
                            start: whole.start,
                            end: whole.start,
                            text: format!("{open}{exports} = "),
                        });
                        edits.push(Edit { start: whole.end, end: whole.end, text: close.to_string() });
                    } else if statement {
                        edits.push(Edit {
                            start: whole.start,
                            end: whole.end,
                            text: format!("{name} = {exports} = {name} {} 1", step.0),
                        });
                    } else {
                        // `a++` becomes `(a = exports.a = a + 1, a - 1)`.
                        edits.push(Edit {
                            start: whole.start,
                            end: whole.end,
                            text: format!(
                                "({name} = {exports} = {name} {} 1, {name} {} 1)",
                                step.0, step.1
                            ),
                        });
                    }
                }
                _ => return decline("an exported binding is assigned in a way sucrase does not follow"),
            }
        }
    }

    // Every use of an imported binding: sucrase's `processIdentifier`.
    for (symbol, replacement) in &replacements {
        for reference in scoping.get_resolved_references(*symbol) {
            if reference.is_write() {
                return decline("an imported binding is assigned");
            }
            let node = reference.node_id();
            let span = nodes.kind(node).span();
            if replaced.iter().any(|whole| whole.start <= span.start && span.end <= whole.end) {
                continue;
            }
            let name = text(span);
            match nodes.parent_kind(node) {
                AstKind::ObjectProperty(property) if property.shorthand => {
                    edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: format!("{name}: {replacement}"),
                    });
                }
                // `f(…)`: called with no `this`, as an imported function is.
                AstKind::CallExpression(call)
                    if !call.optional && call.callee.span() == span =>
                {
                    let after = &source[span.end as usize..];
                    let gap = after.len() - after.trim_start().len();
                    if !after[gap..].starts_with('(') {
                        return decline("a call with something before its arguments");
                    }
                    edits.push(Edit {
                        start: span.start,
                        end: span.end + gap as u32 + 1,
                        text: format!("{replacement}.call(void 0, "),
                    });
                }
                AstKind::ParenthesizedExpression(_) => {
                    // `(f)(…)`: sucrase's `(0, f)`.
                    let mut outer = nodes.parent_id(node);
                    while let AstKind::ParenthesizedExpression(_) = nodes.parent_kind(outer) {
                        outer = nodes.parent_id(outer);
                    }
                    let called = match nodes.parent_kind(outer) {
                        AstKind::CallExpression(call) => {
                            !call.optional && call.callee.span() == nodes.kind(outer).span()
                        }
                        _ => false,
                    };
                    edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: if called {
                            format!("(0, {replacement})")
                        } else {
                            replacement.clone()
                        },
                    });
                }
                _ => edits.push(Edit {
                    start: span.start,
                    end: span.end,
                    text: replacement.clone(),
                }),
            }
        }
    }

    edits.sort_by_key(|edit| (edit.start, edit.end));
    let mut code = String::with_capacity(source.len() + source.len() / 8 + 1024);
    code.push_str("\"use strict\";");
    if had_export {
        code.push_str("Object.defineProperty(__webnode_exports, \"__esModule\", {value: true});");
    }
    if helpers.wildcard {
        code.push_str(HELPER_WILDCARD);
    }
    if helpers.default {
        code.push_str(HELPER_DEFAULT);
    }
    if helpers.from {
        code.push_str(HELPER_FROM);
    }
    if helpers.star {
        code.push_str(HELPER_STAR);
    }
    let mut at = 0usize;
    for edit in &edits {
        let (start, end) = (edit.start as usize, edit.end as usize);
        if start < at {
            return decline("two rewrites of one place");
        }
        code.push_str(&source[at..start]);
        code.push_str(&edit.text);
        at = end;
    }
    code.push_str(&source[at..]);
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::rewrite;

    fn rewritten(source: &str) -> String {
        rewrite(source).expect("rewritten")
    }

    #[test]
    fn one_require_for_each_path_with_sucrases_helpers() {
        let code = rewritten(
            "import d, { a, b as c } from './x.js';\nimport * as ns from \"./y.js\";\nimport './z.js';\nd(a, c, ns);\n",
        );
        assert!(code.starts_with("\"use strict\";"));
        assert!(code.contains("var __wnr_m0 = __webnode_require('./x.js'); var __wnr_d0 = __wnr_default(__wnr_m0);"));
        assert!(code.contains("var __wnr_m1 = __webnode_require(\"./y.js\"); var ns = __wnr_wildcard(__wnr_m1);"));
        assert!(code.contains("__webnode_require('./z.js');"));
        assert!(code.contains("__wnr_d0.default.call(void 0, __wnr_m0.a, __wnr_m0.b, ns);"));
        assert!(!code.contains("__esModule\", {value: true}"));
    }

    #[test]
    fn a_path_named_twice_is_required_once() {
        let code = rewritten("import { a } from 'x';\nimport { b } from 'x';\nexport { c } from 'x';\na; b;\n");
        assert_eq!(code.matches("__webnode_require('x')").count(), 1);
        assert!(code.contains("__wnr_from(__wnr_m0, 'c', 'c');"));
        assert!(code.contains("__wnr_m0.a; __wnr_m0.b;"));
    }

    #[test]
    fn a_use_keeps_its_place_and_its_meaning() {
        let code = rewritten(
            "import { f, v } from 'x';\nconst o = { v, f };\n(f)(1);\nnew f(v);\nf?.(2);\nf`t`;\nfunction g(v) { return v; }\n",
        );
        assert!(code.contains("const o = { v: __wnr_m0.v, f: __wnr_m0.f };"));
        assert!(code.contains("((0, __wnr_m0.f))(1);"));
        assert!(code.contains("new __wnr_m0.f(__wnr_m0.v);"));
        assert!(code.contains("__wnr_m0.f?.(2);"));
        assert!(code.contains("__wnr_m0.f`t`;"));
        assert!(code.contains("function g(v) { return v; }"));
    }

    #[test]
    fn each_kind_of_export() {
        let code = rewritten(
            "export const a = 1, b = 2;\nexport function f() {}\nexport class C {}\nconst x = 1;\nexport { x, x as y };\nexport default x;\nexport * from 'm';\nexport * as all from 'n';\n",
        );
        assert!(code.contains("Object.defineProperty(__webnode_exports, \"__esModule\", {value: true});"));
        assert!(code.contains("const a = 1, b = 2;;__webnode_exports.a = a;__webnode_exports.b = b;"));
        assert!(code.contains("function f() {} __webnode_exports.f = f;"));
        assert!(code.contains("class C {} __webnode_exports.C = C;"));
        assert!(code.contains("__webnode_exports.x = x; __webnode_exports.y = x;"));
        assert!(code.contains("__webnode_exports.default = x;"));
        assert!(code.contains("var __wnr_m0 = __webnode_require('m'); __wnr_star(__wnr_m0);"));
        assert!(code.contains(
            "var __wnr_m1 = __webnode_require('n'); var __wnr_d1 = __wnr_wildcard(__wnr_m1); __webnode_exports.all = __wnr_d1;"
        ));
    }

    #[test]
    fn a_default_that_declares_and_one_that_does_not() {
        assert!(rewritten("export default function named() {}").contains("function named() {} __webnode_exports.default = named;"));
        assert!(rewritten("export default class Named {}").contains("class Named {} __webnode_exports.default = Named;"));
        assert!(rewritten("export default function () {}").contains("__webnode_exports.default = function () {};"));
        assert!(rewritten("export default class {}").contains("__webnode_exports.default = class {};"));
        assert!(rewritten("export default async function* named() {}")
            .contains("async function* named() {} __webnode_exports.default = named;"));
    }

    #[test]
    fn every_line_stays_where_it_was() {
        let source = "import {\n  a,\n  b,\n} from 'x';\nexport {\n  a,\n};\nexport const c = b;\n";
        let code = rewritten(source);
        assert_eq!(code.matches('\n').count(), source.matches('\n').count());
        assert!(code.lines().nth(7).unwrap().contains("const c = __wnr_m0.b;"));
    }

    #[test]
    fn an_assignment_to_an_exported_binding_reaches_the_export() {
        let code = rewritten(
            "export let a = 1;\nlet b = 1;\nexport { b, b as c };\na = 2;\na += 3;\n++a;\na--;\nconst d = a++ + --b;\nvar E;\n(function (E) {})(E || (E = {}));\nexport { E };\n",
        );
        assert!(code.contains("\na = __webnode_exports.a = 2;"));
        assert!(code.contains("\na = __webnode_exports.a += 3;"));
        assert!(code.contains("\n__webnode_exports.a = ++a;"));
        assert!(code.contains("\na = __webnode_exports.a = a - 1;"));
        assert!(code.contains(
            "const d = (a = __webnode_exports.a = a + 1, a - 1) + (__webnode_exports.b = __webnode_exports.c = --b);"
        ));
        assert!(code.contains("(E || (E = __webnode_exports.E = {}));"));
    }

    #[test]
    fn what_it_leaves_to_sucrase() {
        for source in [
            "export let a = 1; [a] = [2];",
            "let a = 1; export { a }; for (a of [1]) {}",
            "export let a = 1; f(1)\n++a + 1;",
            "export const { a, b } = {};",
            "export const a = ;",
            "import { a } from 'x'; a = 1;",
            "import { a } from 'x'; const __wnr_m0 = a;",
            "export { missing };",
        ] {
            assert!(rewrite(source).is_err(), "{source}");
        }
    }
}
