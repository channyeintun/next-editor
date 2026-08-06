import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Kite web lesson starter: a real page, with the parts worth type checking
 * written in Kite.
 *
 * This is the `kite` starter's opposite number. That one is a console program
 * compiled in the page by the bundled compiler; this one is a Vite project in
 * the WebContainer, with a dev server and a live preview — the setup someone
 * would actually ship.
 *
 * **Nothing native is installed.** `vite-plugin-kite` depends on
 * `@kite-lang/compiler-wasm`, which is the Kite compiler built for
 * WebAssembly, so `npm install` brings the compiler with it. A native binary
 * could not run here at all: the WebContainer executes WebAssembly and
 * JavaScript and no machine code.
 *
 * There is no JavaScript in `src/`. The DOM work is Kite over `std/dom`, and
 * the only JavaScript in the project is the two lines Vite generates to
 * instantiate the module.
 */
export function createStarterKiteWebWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      `{
  "name": "kite-web-lesson",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 4173",
    "build": "vite build",
    "preview": "vite preview --host 0.0.0.0 --port 4173",
    "check": "kitec check src/main.kite && kitec check src/about.kite",
    "fmt": "kitec fmt src/main.kite src/about.kite src/checkout.kite"
  },
  "devDependencies": {
    "@kite-lang/compiler-wasm": "^0.1.1",
    "vite": "^8.1.3",
    "vite-plugin-kite": "^0.1.1"
  }
}
`,
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { resolve } from "node:path";
import kite from "vite-plugin-kite";

// Two pages, each running its own program. Nothing about \`index.html\` or
// \`main.kite\` is special: the plugin wires whatever a \`<script type="module">\`
// points at, in whatever HTML Vite is given.
export default {
  plugins: [kite()],
  server: { host: "0.0.0.0", port: 4173 },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        about: resolve(import.meta.dirname, "about.html"),
      },
    },
  },
};
`,
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kite + Vite</title>
<link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <main>
    <h1>Kite + Vite</h1>
    <p class="lede">
      Every number below is computed by WebAssembly, compiled from
      <code>src/checkout.kite</code> by <code>kitec</code> as part of the Vite
      build. The markup is HTML and the styling is CSS, which keep their jobs.
    </p>

    <section>
      <h2>An order</h2>
      <ul id="items"></ul>
      <p class="row"><label>Discount <input id="percent" type="number" value="10" min="0" max="100"> %</label></p>
      <dl class="totals">
        <dt>Subtotal</dt><dd><output id="subtotal">—</output></dd>
        <dt>Discount</dt><dd><output id="discount">—</output></dd>
        <dt>VAT at 20%</dt><dd><output id="vat">—</output></dd>
        <dt class="grand">Total</dt><dd class="grand"><output id="total">—</output></dd>
      </dl>
      <p class="row">
        <input id="what" type="text" placeholder="Something" aria-label="Item">
        <input id="price" type="text" placeholder="12.99" aria-label="Price">
        <button id="add" type="button">Add</button>
      </p>
      <p id="price-note" class="note"></p>
    </section>

    <section>
      <h2>A card number</h2>
      <p>
        The Luhn check catches a mistyped digit and a transposed pair. It is
        nine lines of Kite, and the kind of thing worth having a compiler over.
      </p>
      <p class="row"><input id="card" type="text" inputmode="numeric" placeholder="4242 4242 4242 4242" aria-label="Card number"></p>
      <p id="card-note" class="note"></p>
    </section>
  </main>
  <script type="module" src="/src/main.kite"></script>
</body>
</html>
`,
    ),
    "about.html": createWorkspaceFile(
      "about.html",
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>About — Kite + Vite</title>
<link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <main>
    <h1>A second page</h1>
    <p>Neither this page nor its program is called <code>index</code> or
    <code>main</code>. It runs <code>src/about.kite</code>.</p>
    <p>1205 pence, formatted by Kite: <output id="pence">—</output></p>
    <p><a href="/index.html">Back</a></p>
  </main>
  <script type="module" src="/src/about.kite"></script>
</body>
</html>
`,
    ),
    "src/main.kite": createWorkspaceFile(
      "src/main.kite",
      `//! A checkout, in Kite.
//!
//! Not "Kite doing the arithmetic while JavaScript drives the page" — the
//! program owns this part of the page and there is no JavaScript in the
//! project but the two lines that instantiate it. Reading the inputs,
//! listening for events, writing the rows: all of it is here, over \`std/dom\`.
//!
//! HTML and CSS keep their jobs. The markup in \`index.html\` is real markup and
//! the class names pass through exactly as written, so a stylesheet somebody
//! else wrote — this one, or Tailwind, or a design system you already own —
//! works on it unchanged.

use std/dom
use std/html
use checkout

/// What the page is showing. A struct rather than loose bindings, because a
/// closure may not capture a \`var\` — it captures a \`let\` handle to this, and
/// the functions that change it take it as \`var\`.
struct View {
    var lines: [Line]
    var percent: int
}

struct Line {
    what: str
    price: int
    quantity: int
}

fn starting_lines() -> [Line] {
    return [
        Line { what: "Keyboard", price: 8999, quantity: 1 },
        Line { what: "Cable", price: 450, quantity: 3 },
        Line { what: "Stand", price: 2075, quantity: 1 },
    ]
}

// ---- drawing ----------------------------------------------------------------

/// The rows, rebuilt from the model.
///
/// \`std/html\` compares a description against the last one and writes only what
/// differs, so a row that did not change is not touched — and the element
/// keeps its focus and its scroll position.
fn rows(lines: [Line]) -> [html.Node] {
    var out: [html.Node] = []
    for line in lines {
        out.push(html.keyed(line.what, html.el("li", [], [
                        html.txt("span", [], "\\(line.what) × \\(line.quantity)"),
                        html.txt("output", [], checkout.money(
                                checkout.line_total(line.price, line.quantity))),
                    ])))
    }
    return out
}

fn subtotal_of(lines: [Line]) -> int {
    var total = 0
    for line in lines {
        total = total + checkout.line_total(line.price, line.quantity)
    }
    return total
}

fn write(id: str, body: str) {
    let target = dom.find(id)
    if target == nil {
        return
    }
    let err = dom.set_text(target, body)
    if err != nil {
        io.error("\\(id): \\(err.message())")
    }
}

/// Everything on the page that depends on the model.
fn refresh(var view: html.Mounted, model: View) {
    let err = html.update(view, rows(model.lines))
    if err != nil {
        io.error("could not draw: \\(err.message())")
        return
    }

    let subtotal = subtotal_of(model.lines)
    let off = checkout.discount(subtotal, model.percent)
    let net = subtotal - off
    let vat = checkout.tax(net, 2000)

    write("#subtotal", checkout.money(subtotal))
    write("#discount", "−\\(checkout.money(off))")
    write("#vat", checkout.money(vat))
    write("#total", checkout.money(net + vat))
}

// ---- changing ---------------------------------------------------------------

fn set_percent(var model: View, text: str) {
    let typed = parse_int(text.trim())
    model.percent = if typed == nil { 0 } else { clamp(typed, 0, 100) }
}

fn add_line(var model: View, what: str, price: int) {
    var lines = model.lines
    lines.push(Line{ what: what, price: price, quantity: 1 })
    model.lines = lines
}

fn note(id: str, body: str, bad: bool) {
    let target = dom.find(id)
    if target == nil {
        return
    }
    let terr = dom.set_text(target, body)
    if terr != nil {
        io.error(terr.message())
    }
    let cerr = dom.set_class(target, "failed", bad)
    if cerr != nil {
        io.error(cerr.message())
    }
}

fn value_of(id: str) -> str {
    let field = dom.find(id)
    if field == nil {
        return ""
    }
    return dom.value(field)
}

// ---- wiring -----------------------------------------------------------------

fn listen(id: str, event: str, handler: fn(dom.Event)) {
    let target = dom.find(id)
    if target == nil {
        io.error("no \\(id) to listen to")
        return
    }
    let (sub, err) = dom.on(target, event, handler)
    if err != nil {
        io.error("\\(id): \\(err.message())")
    }
}

pub fn main() {
    let list = dom.find("#items")
    if list == nil {
        io.error("no #items to mount into")
        return
    }
    let (mounted, merr) = html.mount(list, [])
    if merr != nil {
        io.error("could not mount: \\(merr.message())")
        return
    }

    // A \`let\` handle to a struct, which is what a closure may capture. The
    // functions that change it take it as \`var\`, so every mutation is spelled
    // out in a signature rather than implied by the capture.
    let model = View{ lines: starting_lines(), percent: 10 }
    refresh(mounted, model)

    listen("#percent", "input", |e: dom.Event| {
            set_percent(model, dom.event_value(e))
            refresh(mounted, model)
        })

    listen("#add", "click", |e: dom.Event| {
            let price = checkout.parse_price(value_of("#price"))
            if price < 0 {
                note("#price-note", "that is not a price", true)
                return
            }
            note("#price-note", "", false)
            let what = value_of("#what")
            add_line(model, if what.len() == 0 { "Something" } else { what }, price)
            refresh(mounted, model)
        })

    listen("#card", "input", |e: dom.Event| {
            let typed = dom.event_value(e)
            if typed.trim().len() == 0 {
                note("#card-note", "", false)
                return
            }
            let ok = checkout.card_looks_valid(typed)
            note("#card-note", if ok { "passes the Luhn check" } else { "does not check out" }, !ok)
        })
}
`,
    ),
    "src/about.kite": createWorkspaceFile(
      "src/about.kite",
      `//! A second page's program, to show that nothing here is special-cased.
//!
//! Neither the page nor the program is named \`index\` or \`main\`. The plugin
//! wires whatever a \`<script type="module">\` points at, in whatever HTML file
//! Vite is given.

use std/dom
use checkout

pub fn main() {
    let target = dom.find("#pence")
    if target == nil {
        return
    }
    let err = dom.set_text(target, checkout.money(1205))
    if err != nil {
        io.error(err.message())
    }
}
`,
    ),
    "src/checkout.kite": createWorkspaceFile(
      "src/checkout.kite",
      `// The arithmetic a checkout must not get wrong, in Kite.
//
// Nothing here knows it is on a web page: no DOM, no \`std/js\`. It takes values
// and answers with values, and \`src/main.js\` puts the answers on the screen.
// That is the split worth having — this is the half where being wrong costs
// money, and it is the half with a type checker over it.
//
// **Everything here takes and answers with \`int\`, \`float\`, \`bool\` or \`str\`,
// and that is a real limit rather than a style.** Those four are what the
// generated wrapper knows how to convert. A slice, an \`Option<T>\` or a
// \`(T, error)\` pair is still exported by the module, but \`api.js\` will not
// describe it — so the list of prices lives in JavaScript and each price
// crosses on its own.

/// One line of the order, in pence.
///
/// Multiplication in integers, never in floats. \`0.1 + 0.2\` is the oldest
/// money bug there is, and the way not to have it is to never hold money in a
/// float — the pennies are the unit.
pub fn line_total(pence: int, quantity: int) -> int {
    if quantity <= 0 {
        return 0
    }
    return pence * quantity
}

/// Tax on an amount, rounded half up, in pence.
///
/// The rounding is written out rather than left to a cast: \`as int\` truncates
/// towards zero, which quietly loses a penny per line and is discovered by an
/// accountant rather than by a test.
pub fn tax(pence: int, rate_basis_points: int) -> int {
    let raw = pence * rate_basis_points
    return (raw + 5000) / 10000
}

/// A discount of \`percent\`, floored, so a rounding error can never *add*
/// money to somebody's order.
pub fn discount(pence: int, percent: int) -> int {
    let capped = clamp(percent, 0, 100)
    return pence * capped / 100
}

/// Money, from pence.
///
/// The pence are padded, so 1205 is \`£12.05\` and not \`£12.5\` — which is the
/// bug this function exists in order not to have.
pub fn money(pence: int) -> str {
    let sign = if pence < 0 { "-" } else { "" }
    let n = abs(pence)
    return "\\(sign)£\\(n / 100).\\(pad_start("\\(n % 100)", 2, "0"))"
}

/// Whether a card number passes the Luhn check.
///
/// Not a validity check — it catches a mistyped digit and a transposed pair,
/// which is all it has ever been for. A number that passes may still belong to
/// nobody.
///
/// Spaces and hyphens are ignored, because that is how people type a card
/// number. Anything else makes it false rather than being skipped: a letter in
/// a card number is a wrong card number, not a character to step over.
pub fn card_looks_valid(digits: str) -> bool {
    var sum = 0
    var count = 0
    var i = digits.len() - 1
    for i >= 0 {
        let c = digits.code_at(i)
        if c == 32 || c == 45 {
            i -= 1
            continue
        }
        if c < 48 || c > 57 {
            return false
        }
        var d = c - 48
        if count % 2 == 1 {
            d = d * 2
            if d > 9 {
                d = d - 9
            }
        }
        sum = sum + d
        count += 1
        i -= 1
    }
    if count < 12 {
        return false
    }
    return sum % 10 == 0
}

/// A price typed by a person, as pence, or -1 when it is not a price.
///
/// -1 rather than an \`Option<int>\`, and it is the limit above showing through:
/// an optional does not cross the wrapper yet. Inside Kite this would answer
/// \`Option<int>\` and the caller could not forget to open it.
pub fn parse_price(text: str) -> int {
    let body = text.trim()
    if body.len() == 0 {
        return -1
    }
    let point = body.index_of(".")
    if point < 0 {
        let whole = parse_int(body)
        if whole == nil {
            return -1
        }
        return whole * 100
    }
    let rest = body.slice(point + 1, body.len())
    if rest.len() != 2 {
        return -1
    }
    // One test per optional, and each on its own. Testing two things with
    // \`||\` does not narrow either of them — on the branch where the whole
    // condition was false, the compiler cannot say which half made it so.
    let pounds = parse_int(body.slice(0, point))
    if pounds == nil {
        return -1
    }
    let pence = parse_int(rest)
    if pence == nil {
        return -1
    }
    return pounds * 100 + pence
}
`,
    ),
    "src/style.css": createWorkspaceFile(
      "src/style.css",
      `:root { color-scheme: light dark; --gold: #e9a63c; --bad: #c0392b; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 48px 24px;
  font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 2rem; margin: 0 0 8px; }
h2 { font-size: 1.15rem; margin: 40px 0 8px; }
.lede { opacity: 0.75; margin-top: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
ul { list-style: none; padding: 0; margin: 0 0 12px; }
li { padding: 8px 12px; border: 1px solid color-mix(in oklab, currentColor 15%, transparent); border-radius: 8px; margin-bottom: 6px; }
li.dearest { border-color: var(--gold); font-weight: 600; }
.total { font-size: 1.2rem; }
output { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
output.failed { color: var(--bad); }
button, input {
  font: inherit; padding: 10px 16px; min-height: 48px;
  border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 25%, transparent);
  background: transparent; color: inherit;
}
button { cursor: pointer; }
button:hover { border-color: var(--gold); }
li { display: flex; justify-content: space-between; gap: 16px; }
li small { opacity: 0.6; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.totals { display: grid; grid-template-columns: 1fr auto; gap: 4px 24px; margin: 16px 0; }
.totals dt, .totals dd { margin: 0; }
.totals dd { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.totals .grand { font-weight: 700; font-size: 1.15rem; border-top: 1px solid currentColor; padding-top: 8px; margin-top: 4px; }
.note { min-height: 1.6em; margin: 8px 0 0; }
.note.failed { color: var(--bad); }
.note.passes { color: #1e8449; }
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Kite + Vite

A checkout, where the arithmetic is Kite compiled to WebAssembly and the page
is HTML and CSS. Press **Run** to start the dev server and open the preview.

Kite's compiler is itself WebAssembly, so \`npm install\` brings it with the
project — there is no binary to install and nothing is downloaded beyond the
packages npm already fetched.

## Two things to try

**Edit \`src/checkout.kite\` and watch the preview.** The arithmetic, the tax
and the discount are all Kite. The DOM work in \`src/main.kite\` is Kite too,
over \`std/dom\` — there is no JavaScript in \`src/\` at all.

**Read a value before checking its error.** In \`src/checkout.kite\`, move a
print above its \`if err != nil\` and save. The build fails, because on a failure
path there is no value at all — not a zero. That rule is the language's whole
point, and it is enforced at compile time rather than in a review.

## What is where

| | |
|---|---|
| \`src/main.kite\` | Reads the inputs, listens for events, draws the rows. |
| \`src/checkout.kite\` | Line totals, tax, discounts, money formatting. No DOM. |
| \`src/about.kite\` | The second page's program. Any HTML can wire any \`.kite\`. |
| \`index.html\`, \`about.html\` | The markup, which keeps its job. |
| \`src/style.css\` | The stylesheet, which keeps its job. |
`,
    ),
  };

  return {
    id: "kite-web-workspace",
    name: "Kite Web Lesson",
    lessonType: "kite-web",
    entryFilePath: "src/main.kite",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
