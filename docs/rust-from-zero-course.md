# Rust from zero — course guide

A 20-lesson Rust course for developers who already know another language. Every lesson is a studio
LessonScript in `src/studio/scripts/`, about 3.5–4 minutes long (about 75 minutes in total). Each one
explains why Rust works the way it does, builds the code step by step, shows the real compiler
error for breaking the rule, runs the program once, and ends with a recap and a pointer to the next
lesson.

Rendering and uploading are done by hand, one module per week, in the order below. The lessons use
the titles "Rust from zero: …", so the catalog groups them; add them to one playlist in this order.

## Week by week

| Week | Module                 | #   | Script                | Title                                    | Visuals          |
| ---- | ---------------------- | --- | --------------------- | ---------------------------------------- | ---------------- |
| 1    | First steps            | 1   | `rust-hello`          | Rust from zero: Your first program       | whiteboard       |
|      |                        | 2   | `rust-variables`      | Rust from zero: Variables and mutability | whiteboard       |
|      |                        | 3   | `rust-data-types`     | Rust from zero: Data types               | whiteboard       |
|      |                        | 4   | `rust-functions`      | Rust from zero: Functions                | whiteboard       |
|      |                        | 5   | `rust-control-flow`   | Rust from zero: Control flow             | whiteboard       |
| 2    | Ownership              | 6   | `rust-ownership`      | Rust from zero: Ownership                | deck + board     |
|      |                        | 7   | `rust-borrow`         | Rust from zero: References and borrowing | own deck + board |
|      |                        | 8   | `rust-slices`         | Rust from zero: Slices                   | whiteboard       |
| 3    | Structuring data       | 9   | `rust-structs`        | Rust from zero: Structs                  | whiteboard       |
|      |                        | 10  | `rust-enums`          | Rust from zero: Enums and Option         | deck + board     |
|      |                        | 11  | `rust-match`          | Rust from zero: Pattern matching         | whiteboard       |
| 4    | Collections and errors | 12  | `rust-vectors`        | Rust from zero: Vectors                  | whiteboard       |
|      |                        | 13  | `rust-strings`        | Rust from zero: Strings                  | whiteboard       |
|      |                        | 14  | `rust-hashmaps`       | Rust from zero: Hash maps                | whiteboard       |
|      |                        | 15  | `rust-error-handling` | Rust from zero: Error handling           | deck + board     |
| 5    | Abstraction            | 16  | `rust-generics`       | Rust from zero: Generics                 | deck + board     |
|      |                        | 17  | `rust-traits`         | Rust from zero: Traits                   | deck + board     |
|      |                        | 18  | `rust-lifetimes`      | Rust from zero: Lifetimes                | deck + board     |
|      |                        | 19  | `rust-iterators`      | Rust from zero: Iterators and closures   | whiteboard       |
|      |                        | 20  | `rust-word-count`     | Rust from zero: Putting it together      | whiteboard       |

"deck" means pages of the branded "Next Editor · Rust" Google deck; `rust-borrow` uses its own
deck. Every other visual is a whiteboard diagram drawn in as the narration explains it.

## Rendering a lesson

1. Open `/studio`, pick the lesson from the dropdown (or open `/studio?plan=<script>`), keep the tab
   in front (Start render is disabled while the tab is hidden), and press **Start render**.
2. The run uses the lesson's fixture, so no sign-in is needed for the render itself. Lessons with deck
   slides fetch the deck from Google at render time and allow a 500 ms timing gate instead of 300 ms
   (painting a deck slide briefly stalls the page).
3. When every check passes, watch the replay, then **Create draft…**, publish, and add the lesson to
   the course playlist.

## What to look at while reviewing

- **Whiteboard fit.** The board layouts were measured from text widths, not seen in a render. Check
  that no label runs past its box or off the board.
- **Spoken code words.** The narration says "print line" for `println!` and "f n" for `fn`, the same
  way in every lesson. Listen once in lesson 1 and decide whether that's the sound you want.
- **Pacing.** Every lesson compiles without inserted silence against estimated dialog lengths; the
  real voice can still run longer or shorter than the estimate.
- **Run in the published lesson.** Learners must be signed in to press Run in a Rust lesson (the
  Rust Playground proxy requires a session). The recorded run replays for everyone.

## Replacing the July borrowing lesson

`rust-borrow` was published in July as a standalone lesson. Its script is now lesson 7 of this course
(eleven scenes, same deck). After uploading the new render, unpublish the July lesson so the catalog
has one borrowing lesson.

## Maintaining the course

- The authoring contract is [lesson-script-authoring.md](./lesson-script-authoring.md); the voice
  rules are [studio-persona.md](./studio-persona.md).
- Every fixture is the exact output of the final program, built with `rustc --edition 2024`, and
  every program compiles without warnings. Every compiler error a lesson shows was produced by
  compiling the broken version, not written from memory. Keep both true when editing a lesson.
- Each lesson's last line names the next lesson's topic, so moving or removing a lesson means
  updating its neighbours.
