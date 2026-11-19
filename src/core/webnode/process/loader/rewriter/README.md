# The Rust rewriter

The loader runs an ES module by rewriting its `import` and `export`
statements into calls on its own bindings (`__webnode_require`,
`__webnode_exports`; ../transform.ts). sucrase does that rewrite, and makes
one object for every token of the file to do it: for Vite's main chunk
(2.1 MB) about 0.3 s and 50 MB of JavaScript heap, which the browser is slow
to give back. This module does the same rewrite in Rust, compiled to
WebAssembly: the same file in about 65 ms, in memory that is the module's own
and goes with the worker that loaded it.

It is used for one thing: the worker that makes large modules' entries
(../prepareWorker.ts, kernel/preparedModules.ts) rewrites with it. Processes
never load it, and every other module is still rewritten by sucrase.

## The contract

`rewrite(text)` takes what transform.ts hands sucrase (the module's text with
`import()`, `import.meta` and the rest already rewritten, the `import`
declarations lifted to the top) and answers the code sucrase's `imports`
transform would have produced, statement for statement:

- one `var … = __webnode_require(…)` for each path, where the first statement
  that names the path was, with sucrase's interop helpers under this module's
  names (`__wnr_default`, `__wnr_wildcard`, `__wnr_from`, `__wnr_star`);
- each use of an imported name read from the module object
  (`f(x)` → `__wnr_m0.f.call(void 0, x)`, `{ a }` → `{ a: __wnr_m0.a }`), found
  by resolving every reference to its binding, so a name of the module's own
  that hides an imported one is left alone;
- each export assigned to `__webnode_exports` where its statement was, and an
  assignment to an exported binding (`a = v`, `a += v`, `++a`, `a++`) carried
  to the export as sucrase carries it;
- every line where it was: a statement that shrinks to one line keeps its line
  breaks.

Nothing is printed from the syntax tree. The source is edited in place, so
whatever is not an `import`, an `export` or a use of an imported name stays
byte for byte.

**What it declines** (`RewriteDeclined`; the caller then uses sucrase): a
source that does not parse or check as a module, one that already uses the
`__wnr_` prefix, an exported destructuring declaration, an exported binding
assigned by a pattern or a loop head, an import with a phase, TypeScript
module syntax. Two inputs sucrase gets wrong it gets right, and they are not
declined: several names exported by one declaration, and a label spelled like
an imported name.

## Building and testing

- The crate (`crate/`) depends on the oxc parser and its scope analysis.
  `bun run build:webnode-rewriter` builds it for wasm32-unknown-unknown, runs
  `wasm-opt`, and writes `wasm.generated.ts`, which is committed: tests and
  deploys need no Rust toolchain. The first build fetches the crates.
- `wasm.generated.test.ts` fails when the crate changed and the module was
  not rebuilt.
- `cargo test --offline` in `crate/`: what the code looks like for each form.
- `rewriter.test.ts`: the rewriter against sucrase, through the loader. Each
  module there is loaded once from an entry this rewriter made and once
  rewritten by sucrase, and must behave the same.
- The rewritten code depends on this module, so it is part of the name the
  kept entries are versioned by (build/webnodeBundle.ts, `webnodeTransformId`).
