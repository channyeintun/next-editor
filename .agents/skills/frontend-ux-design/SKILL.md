---
name: frontend-ux-design
description: >-
  Design the user experience of a web UI before writing it. Use this whenever
  you're about to build or change any user-facing frontend — a form, a button,
  a control, a flow, a settings page, a dashboard, a modal, a list, an editor
  interaction, anything a person clicks or types into. It produces a short UX
  design spec (user intent, states, interaction edge cases, smart defaults,
  progressive disclosure, and what to deliberately leave out) for the user to
  approve, then builds against it. Trigger this even when the request sounds
  trivial ("just add a button", "make a quick form", "add a delete option") —
  those are exactly the moments where unconsidered UX leaks through. Do NOT
  skip straight to code for interface work.
---

# Frontend UX Design

## Why this exists

Great interfaces feel obvious. The user clicks the thing and it does what they
expected — no surprise, no recovery, no "where did it go?". That feeling is not
the result of _less_ work. It is the result of a lot of hidden work: someone sat
down and enumerated every state the UI can be in, every ambiguous case, every
near-miss, and decided what should happen — then buried all of it behind an
interface that looks simpler than Paint.

The failure mode this skill prevents is the common one: dropping inputs, buttons,
and forms onto a page without deciding what happens at the boundaries. That ships
fast and feels cheap forever after. The boundaries are where UX lives.

A guiding line, paraphrased from the Figma team: **users don't care about your
rules; they care that it works the way they expect — and those are not the same
thing.** Your job is to design to expectation, which usually means writing _more_
rules, not fewer, so that each individual case does the obvious thing.

## The workflow

When you're about to build or modify any web interface, **do not start with code.**
First write a UX design spec (template below), show it to the user, and get a
quick sign-off or correction. Then implement against it.

Keep the spec proportional to the work. A single button might be half a page; a
multi-step flow might be two pages. The point is not ceremony — it's forcing the
decisions about states and edge cases _before_ they get hard-coded by accident.
If something is genuinely a one-liner with no states and no ambiguity (e.g. a
static link to an existing page), say so in one sentence and proceed.

## The spec template

```markdown
# UX Spec: <feature>

## Intent

What is the user actually trying to accomplish here? (Not "click a button" —
the goal behind it.) What do they expect to happen?

## Happy path

The obvious, expected flow, start to finish, in plain steps.

## States

Every state this UI can be in, and what each looks like:

- empty / first-use (no data yet)
- loading / pending
- partial / streaming
- success
- error (which errors? how does the user recover?)
- empty-result vs. not-yet-loaded (these differ)
- disabled / not-permitted
- offline / stale (if relevant)

## Interactions & edge cases

For each control, the boundary and ambiguous cases — this is the core of the spec:

- What happens on a misclick? Can it be undone?
- What happens at the limits (long text, zero items, huge list, off-screen)?
- Overlap/ambiguity: if two things could respond, which one wins, and why?
- Keyboard: shortcuts, focus order, escape/enter behavior.
- What happens mid-action (the user changes their mind, navigates away)?

## Defaults & smart behavior

What do we decide _for_ the user so they don't have to? Pre-filled values,
sensible fallbacks, auto-placement, auto-focus. Defaults are UX.

## Progressive disclosure

What is shown by default vs. revealed on demand? The simple case must be simple;
power must be reachable without cluttering the default view.

## Consistency

Which existing pattern in this app does this reuse? (Same component, same
interaction grammar, same words.) New patterns are a cost — justify them.

## Deliberately NOT doing

Features/options considered and rejected, and why. Saying no is part of the design.
```

## Principles to design against

These are the lenses to run every interface through while writing the spec.
Each is cheap to ignore and expensive to retrofit.

### 1. Design to expectation, then enumerate the rules that achieve it

Start from "what would a user assume happens here?" Then write whatever set of
rules makes that true across all the cases — even if that's a dozen small rules.
Each rule should be simple on its own; it's fine for the _system_ to be complex
as long as each case does the obvious thing. Example: pasting an element at its
original coordinates is correct — until those coordinates are off-screen, where
the obvious behavior is to paste it where the user is looking. That's a second
rule serving the same expectation.

### 2. The boundaries are the design

Empty, full, loading, error, off-screen, zero-items, too-many-items, the misclick,
the overshoot, the mid-action cancel. Unconsidered, each becomes a glitch the user
hits and you patch later. List them up front. If you're only describing the happy
path, you haven't designed the UX yet.

### 3. Make it forgiving

Users misclick, overshoot, and change their mind. Let them recover: undo (even
undo a _selection_, not just a content change), a short grace delay before a
hover target disappears so an overshoot doesn't punish them, confirm-or-undo
instead of hard-blocking, an escape hatch out of every flow. Forgiveness is what
makes an interface feel safe to explore.

### 4. Smart defaults beat options

Every choice you push onto the user is friction. Decide for them when there's a
reasonable default (auto-place, auto-focus, pre-select, sensible fallback) and
let them override only if they need to. A blank form with ten required fields and
no defaults is a UX failure even if every field "works".

### 5. Resolve ambiguity deliberately

When two elements could respond to the same action (the selected item vs. the one
under the cursor; the hovered layer vs. the layer above), the system must pick —
and pick the way the user means, not whatever's easiest to implement. Name the
tie-break in the spec.

### 6. Progressive disclosure: simple by default, power on demand

Lay complexity out as a gradient. The first-time user sees the simple path; the
power user can drill into more control without that control crowding the default
view. Don't make everyone pay the complexity cost of features only some need.

### 7. Reuse the app's existing grammar

If the app already has a pattern for "type something on the canvas" (e.g.
comments), a new feature that also types on the canvas should feel like that same
system — same placement, same expand-on-type, same keys. Consistency is why an
interface feels learnable without a tutorial. A new bespoke pattern is a real
cost; reach for it only when no existing one fits.

### 8. Don't trade discoverability for cleverness

A slick gesture-based or velocity-based reveal feels magical to the person who
built it and is invisible to everyone else — if users can't find it, it doesn't
exist. Favor entry points people can see and learn. Clever hiding is only
acceptable once the thing is already discoverable by an obvious means.

### 9. Protect simplicity by saying no

Every requested feature, mode, and toggle is a tax on the default experience and
sometimes on trust (an "invisible/incognito presence" option, say, can quietly
break the safety others feel). The best products are shaped as much by what they
refuse as by what they add. Put rejected ideas, with reasons, in the spec.

### 10. Track the real metric: does it work how they expect?

You usually can't A/B-test these micro-decisions and you shouldn't need to. The
test is: when a thoughtful user hits this case, do they think "of course" or "huh?"
Aim for "of course" everywhere.

## Worked example (abbreviated)

Request: _"Add a delete button to each row in the list."_

A thoughtless version: an icon button that calls `delete()` on click. Done.

The spec catches what that misses:

- **States**: row mid-delete (optimistic? spinner?), delete fails (does the row
  come back? is there an error?), last row deleted (empty state copy?).
- **Edge cases**: misclick on delete — is it recoverable? A confirm dialog is the
  blunt fix, but an **undo toast** ("Deleted. Undo") is more forgiving and faster
  for the common case. Rapid deletes of several rows — do undos stack?
- **Defaults**: keep focus sensible after a row vanishes (move to the next row,
  don't drop the user to the top).
- **Consistency**: does this app already delete things somewhere? Match it.
- **NOT doing**: no bulk-select in v1 — note it, don't silently omit it.

Same button. Completely different product feel. That gap is the whole job.

## After the build

When you finish implementing, do a quick pass back over the spec's States and
Edge cases section and confirm each one is actually handled in the code — these
are exactly the cases that quietly get dropped during implementation.
