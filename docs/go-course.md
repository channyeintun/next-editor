# Go course — course guide

A 35-lesson Go course, narrated in Burmese, for people who have never programmed. It starts with
**why Go** (lesson 1), writes a first program in lesson 2, and goes step by step through variables,
numbers, text, decisions, loops, functions, slices, maps and Burmese text, then structs, pointers,
methods, a program split over many files, interfaces, errors, closures, generics, iterators, time,
goroutines, channels and a mutex, and ends with a two-lesson capstone and a lesson on running Go on
your own computer. Go terms stay in English; code, program output and compiler messages are shown
exactly as Go prints them, and the narration never reads code aloud.

The course is written for Burmese learners rather than translated: money is whole kyats (`int`),
lakhs explain `/` and `%`, market goods are weighed in viss, exam marks pass at 40 with a
distinction (ဂုဏ်ထူး) at 80, the weekday gives your birth-day animal, a phone number starting with 09
stays a string, Burmese text is counted in bytes and runes (with a syllable like `မုန့်` taking five
runes), Myanmar digits ၀–၉ are converted by hand because `strconv.Atoi` refuses them (and the letter
ဝ is not the digit ၀), and times are Myanmar Time, UTC+06:30. Lessons 1–15 each use their own
everyday example; from lesson 16 one program grows: a small Yangon parcel-delivery service that sends
parcels to other cities by highway bus and delivers in town by motorbike rider. It carries the
many-files lesson, interfaces, errors, time, concurrency and the capstone. The people are only
လှလှ, အောင်အောင် and မောင်မောင်. There is no tea shop in this course.

Every lesson is a studio LessonScript in `src/studio/scripts/go-course-*.yaml` (locale `my-MM`,
`lessonType: go`, the Go Playground runner on Go 1.27.3, fixture mode). Lessons are 7 to 10 minutes
each, **about 4 hours 52 minutes** in total at 70 ms per character (studio-compile-check). The Burmese has
**not** been reviewed by Chan yet, and no lesson has been rendered in /studio yet.

The playlist to create is **`go-course`** ("Go Course (မြန်မာလို)"), lessons in the order below.

## Lessons

**Why Go and first programs (1–5)**

| #   | Script                         | Title                          | ≈ min |
| --- | ------------------------------ | ------------------------------ | ----- |
| 1   | `go-course-01-why-go`          | Go course 01: ဘာကြောင့် Go လဲ     | 9.5   |
| 2   | `go-course-02-hello`           | Go course 02: ပထမဆုံး Go program | 9.2   |
| 3   | `go-course-03-variables`       | Go course 03: Variable နဲ့ type  | 9.2   |
| 4   | `go-course-04-numbers`         | Go course 04: ကိန်းပြည့်နဲ့ ဒသမ ကိန်း  | 8.3   |
| 5   | `go-course-05-text-and-printf` | Go course 05: စာသားနဲ့ Printf    | 7.7   |

**Decisions, loops and functions (6–10)**

| #   | Script                           | Title                                  | ≈ min |
| --- | -------------------------------- | -------------------------------------- | ----- |
| 6   | `go-course-06-if-else`           | Go course 06: if နဲ့ ဆုံးဖြတ်တာ             | 8.4   |
| 7   | `go-course-07-for-loops`         | Go course 07: for loop နဲ့ ထပ်ခါထပ်ခါ လုပ်တာ | 7.9   |
| 8   | `go-course-08-switch`            | Go course 08: switch နဲ့ ရွေးတာ           | 7.7   |
| 9   | `go-course-09-functions`         | Go course 09: Function ဆိုတာ             | 7.5   |
| 10  | `go-course-10-results-and-scope` | Go course 10: Result အများနဲ့ scope      | 8.0   |

**Collections and Burmese text (11–15)**

| #   | Script                       | Title                                    | ≈ min |
| --- | ---------------------------- | ---------------------------------------- | ----- |
| 11  | `go-course-11-slices`        | Go course 11: Slice ဆိုတာ                  | 7.7   |
| 12  | `go-course-12-slices-inside` | Go course 12: Slice ရဲ့ နောက်ကွယ်             | 7.9   |
| 13  | `go-course-13-maps`          | Go course 13: Map နဲ့ ရှာတာ                 | 7.7   |
| 14  | `go-course-14-burmese-text`  | Go course 14: မြန်မာစာ၊ byte နဲ့ rune       | 8.1   |
| 15  | `go-course-15-toolkit`       | Go course 15: Standard library ထဲက ကိရိယာတွေ | 8.4   |

**Your own types (the parcel service begins) (16–21)**

| #   | Script                             | Title                                 | ≈ min |
| --- | ---------------------------------- | ------------------------------------- | ----- |
| 16  | `go-course-16-structs`             | Go course 16: Struct နဲ့ ကိုယ်ပိုင် type      | 8.2   |
| 17  | `go-course-17-pointers`            | Go course 17: Pointer ဆိုတာ             | 8.3   |
| 18  | `go-course-18-methods`             | Go course 18: Method ဆိုတာ              | 7.9   |
| 19  | `go-course-19-many-files`          | Go course 19: Program တစ်ခု၊ file အများ | 8.6   |
| 20  | `go-course-20-interfaces`          | Go course 20: Interface ဆိုတာ           | 8.9   |
| 21  | `go-course-21-any-and-type-switch` | Go course 21: any နဲ့ type switch       | 8.0   |

**Errors and functions as values (22–27)**

| #   | Script                             | Title                                  | ≈ min |
| --- | ---------------------------------- | -------------------------------------- | ----- |
| 22  | `go-course-22-errors`              | Go course 22: Error ဆိုတာ တန်ဖိုးတစ်ခုပါ      | 8.5   |
| 23  | `go-course-23-error-types`         | Go course 23: Error ကို ထုပ်တာနဲ့ error type | 9.1   |
| 24  | `go-course-24-defer-panic-recover` | Go course 24: defer၊ panic နဲ့ recover   | 9.1   |
| 25  | `go-course-25-closures`            | Go course 25: Closure ဆိုတာ              | 8.0   |
| 26  | `go-course-26-generics`            | Go course 26: Generics နဲ့ type မျိုးစုံ     | 8.4   |
| 27  | `go-course-27-iterators`           | Go course 27: Iterator နဲ့ range         | 7.8   |

**Time and concurrency (28–32)**

| #   | Script                            | Title                                  | ≈ min |
| --- | --------------------------------- | -------------------------------------- | ----- |
| 28  | `go-course-28-time`               | Go course 28: အချိန်နဲ့ မြန်မာစံတော်ချိန်       | 8.8   |
| 29  | `go-course-29-goroutines`         | Go course 29: Goroutine နဲ့ တစ်ပြိုင်နက် လုပ်တာ | 7.6   |
| 30  | `go-course-30-channels`           | Go course 30: Channel နဲ့ လက်လွှဲတာ          | 8.8   |
| 31  | `go-course-31-select-and-workers` | Go course 31: select နဲ့ rider အဖွဲ့        | 8.2   |
| 32  | `go-course-32-mutex`              | Go course 32: Mutex နဲ့ တန်ဖိုးတစ်ခုကို မျှသုံးတာ  | 8.7   |

**Capstone and beyond (33–35)**

| #   | Script                          | Title                                           | ≈ min |
| --- | ------------------------------- | ----------------------------------------------- | ----- |
| 33  | `go-course-33-capstone-parcels` | Go course 33: Capstone ၁၊ ပါဆယ် ဈေးတွက်တာ          | 9.0   |
| 34  | `go-course-34-capstone-riders`  | Go course 34: Capstone ၂၊ rider တွေနဲ့ နေ့စဉ် report | 8.7   |
| 35  | `go-course-35-your-computer`    | Go course 35: ကိုယ့်ကွန်ပျူတာပေါ်မှာ Go                  | 8.7   |

## How the lessons work

**Run, change, run again.** Every lesson types its code live and runs it two or three times, so the
learner sees what each change does. This needed a studio feature built for the course
(`runtime.fixture.results`, commit bc818b8b): a Playground lesson pins one result per `runtime.run`,
and each run replays its own output. Every pinned result is the exact output of the program as it
stands at that run, produced and checked by running it with the local Go 1.27.3 (the Playground's
version) ten times with different `GOMAXPROCS` values, so a concurrent program whose output could
change is caught before it ships.

**Errors are part of the lesson.** Most lessons contain one deliberate failing run — a compile error
(`undefined: fmt`, `declared and not used`, `mismatched types int and float64`, `missing return`,
`does not implement`), a vet warning (a Printf verb with its argument missing), or a runtime panic
(index out of range, nil map write, a bad type assertion, a deadlock). Each is read the same way —
position first (file, line, column), then the message in Burmese — and fixed by an insertion before the
lesson ends. Silent bugs (integer division, `:=` shadowing, `append` writing into a shared array, a
value receiver changing a copy, a typed nil in an `error`, a lost update between goroutines) are shown
as runs whose output is wrong, not as errors.

**Several files.** From lesson 19 the parcel program lives in several `package main` files
(`main.go`, `parcel.go`, `fees.go`, `receipt.go`, later `courier.go`, `errors.go`, `digits.go`,
`clock.go`, `riders.go`, `report.go`), which the Go runner compiles together. Lesson 19 is about exactly
that; the capstone uses seven and then nine files. Packages other than `main`, `go.mod` and modules
cannot run on the Playground runner and are taught on the whiteboard (lessons 19 and 35).

**Modern Go.** `for i := range n`, per-iteration loop variables, `min`/`max`, the `slices` and `maps`
packages (`slices.Sorted(maps.Keys(m))` for a stable order), `strings.SplitSeq` and range-over-func
iterators, `sync.WaitGroup.Go`, `new(expr)` and `errors.AsType`. Older forms (`wg.Add`/`Done`, `i := i`,
`errors.As`, `interface{}`) appear only on a board as "what you will see in older code".

**Determinism.** The Playground's clock is fixed and its sleeps are exact, so concurrent lessons use
sleeps at least 100 ms apart, collect results by index or sort them, and print elapsed time rounded to
100 ms; no lesson prints the wall clock, random numbers, or a map in range order.

**The whiteboard carries the ideas**: a diagram drawn as it is named, and one quiz per lesson with a
reasoned answer. There is no slide deck.

## How it was built and checked

The lead set the binding decisions and the curriculum; a Fable 5.2 advisor (advisory only, no Burmese)
proposed the structure, the modern-Go choices and the deliberate error runs, and verified every quoted
Go message locally; a platform agent built per-run fixtures into the studio (with tests) and a tooling
agent built the course's checks (`sim-go` replays all typing and runs each run state against the real
toolchain; narration lint; board checks; length gate; lander); a kit agent wrote the per-lesson specs,
the shared code and data, the glossary and the briefs. A pilot author wrote lessons 2 and 3 (then
numbered 1 and 2) to set the voice, which the lead approved; 16 authors wrote two lessons each, 8
auditors fixed every lesson (four or five each, re-running every gate), one continuity editor read all
lessons as one course, and one more author wrote lesson 1 (Why Go?, added at Chan's request) with a
self-audit, reviewed by the lead. 31 agents in all. The course was then renumbered from 01 and every
lesson re-checked.

Gates every lesson passes: the director (valid, no critic notes), `studio-compile-check` (PASS at 55, 70
and 95 ms per character, no warnings), `sim-go` (every run's output equals its fixture; typing anchors,
selections, console points and gofmt checked at every step), the course lint (spoken register, no code
read aloud, Burmese digits without separators, no tooling chatter, no source names, only the three
names, no tea shop), the board checks (text fit, thin strokes, `#1e1e1e` text, sizes, never maximized)
and the 7–10 minute length gate. Every lesson was landed as its own commit through the repository's
pre-commit hook.

## Decisions taken during the build

- **Why Go first.** Lesson 1 explains where Go came from, what it chose, where it is used, what it is
  not the best tool for, and why it suits a first language, with a taste run of three riders delivering
  at once; every fact is from go.dev and cited.
- **Numbers start at 01.** Lesson numbers in narration and on boards were all moved when Why Go was
  added; lessons say numbers in words (`lesson ဆယ့်ငါး`) as the glossary asks.
- **Money is `int` kyats**, never floating point; amounts and fees are examples, never claims about real
  prices.
- **Insert-only editing leaves honest leftovers** (a commented-out line, a split `var` + `make`); where
  the final code keeps a form that is not the idiom, the narration says once what real code would do.
- **Error texts are English**, like the standard library's; text printed for people is Burmese.
- **Burmese sorting is not dictionary order**: `slices.Sort` on Burmese strings orders by code point, so
  the course sorts by number and never calls it alphabetical.
- **Fixed course words**: တွန့်ကွင်း for braces, လေးထောင့်ကွင်း for square brackets, နမူနာ အချိန် for
  Go's reference time, နှုတ် for minus; course sections are အပိုင်း, never "module" (a Go term in
  lessons 19 and 35); the written connector …ကာ is not used in narration.

## Pronunciation notes

Candidates for `BURMESE_RESPELLINGS`, to confirm after a render (`fmt`, `goroutine` and `struct` are
already in the lexicon): `Println`, `Printf`, `Sprintf`, `gofmt`, `strconv`, `Atoi`, `Itoa`, `float64`,
`UTF-8`, `nil`, `rune`, `mutex`, `WaitGroup`, `iota`, `MMT`, `UTC`, `COD`, `go.mod`, `Docker`,
`Kubernetes`, `Cloudflare`, `Dropbox`, `Netflix`, `PayPal`, `Uber`.

## Thumbnails

`docs/go-course-thumbnail.html` renders all 35 cards (`bun docs/go-course-thumbnails/render.ts`, PNGs
in `docs/go-course-thumbnails/`). The mascot is the **Go gopher**, designed by Renée French and licensed
under Creative Commons Attribution 4.0 (https://go.dev/blog/gopher), redrawn as a flat sticker carrying
the course's parcels; every card prints the credit line, and the playlist description should carry it
too: "Go gopher by Renée French, CC BY 4.0". The Go logo is not used. Each card shows a real line from
the lesson's final code.

## Working files

The curriculum, advisory, kit, glossary, briefs, tools, probes and every lesson's design notes and
audits are outside the repository, in `~/Documents/go-course-work/`.
