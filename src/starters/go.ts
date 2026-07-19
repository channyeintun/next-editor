import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure Go lesson starter seeded with the golang-dev.vercel.app/courses/go
 * course: one runnable demo per course lesson (25 lessons across 10
 * modules), selected from main.go and run together through the Go
 * Playground proxy on an explicit Run action. No package.json, dev server,
 * or WebContainer boot — the workspace stays local until Run.
 */
export function createStarterGoWorkspace(): WorkspaceProject {
  const files = {
    "main.go": createWorkspaceFile(
      "main.go",
      `// Golang: From Source Files to Production
// The lesson workspace for golang-dev.vercel.app/courses/go
//
// HOW TO USE
//  1. Open COURSE.md for the reading path: 6 parts, 10 modules, 25 lessons.
//  2. Set currentLesson below to a lesson key, for example "3.1".
//  3. Press Run. Read the output, then open the matching m*.go file and
//     edit the lesson while re-running. Set it to "all" to run everything.
package main

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// currentLesson selects which lesson demo runs. Change it and press Run.
const currentLesson = "1.1"

type lesson struct {
	title string
	run   func()
}

// lessons is the registry. It starts empty: each m*.go module file adds its
// own entries from an init func, so a lesson's key, title, and demo live
// together in the module that teaches it.
var lessons = map[string]lesson{}

func register(key, title string, run func()) {
	lessons[key] = lesson{title: title, run: run}
}

// courseOrder returns the registered keys in reading order. Map iteration
// order is unspecified (see lesson 3.2), and a plain string sort would put
// "10.1" before "9.3" — so compare module and lesson numbers numerically.
func courseOrder() []string {
	keys := make([]string, 0, len(lessons))
	for key := range lessons {
		keys = append(keys, key)
	}
	slices.SortFunc(keys, func(a, b string) int {
		aModule, aLesson := keyParts(a)
		bModule, bLesson := keyParts(b)
		if aModule != bModule {
			return cmp.Compare(aModule, bModule)
		}
		return cmp.Compare(aLesson, bLesson)
	})
	return keys
}

// keyParts splits a "module.lesson" key like "9.3" into its two numbers.
func keyParts(key string) (int, int) {
	modulePart, lessonPart, _ := strings.Cut(key, ".")
	moduleNumber, _ := strconv.Atoi(modulePart)
	lessonNumber, _ := strconv.Atoi(lessonPart)
	return moduleNumber, lessonNumber
}

func main() {
	if currentLesson == "all" {
		for _, key := range courseOrder() {
			banner(key)
			lessons[key].run()
			fmt.Println()
		}
		return
	}

	l, ok := lessons[currentLesson]
	if !ok {
		fmt.Printf("unknown lesson %q — pick one of:\\n", currentLesson)
		for _, key := range courseOrder() {
			fmt.Printf("  %-5s %s\\n", key, lessons[key].title)
		}
		return
	}

	banner(currentLesson)
	l.run()
}

func banner(key string) {
	fmt.Printf("Lesson %s · %s\\n", key, lessons[key].title)
	fmt.Println("--------------------------------------------------")
}
`,
    ),
    "m01_files_packages_tooling.go": createWorkspaceFile(
      "m01_files_packages_tooling.go",
      `// Module 01 · Files, Packages, Imports, and Tooling
//
// Read Go the way the toolchain reads it: package clause first, imports
// next, declarations after that. Then lean on the daily tools — the Format
// button here runs gofmt, and Run reports go vet findings alongside output:
//
//	gofmt -w .             format every file
//	go vet ./...           report suspicious constructs
//	go test ./...          run the tests
//	go doc fmt.Println     read documentation
package main

import (
	"fmt"
	"strconv"
)

func init() {
	register("1.1", "Read a Go File Top-Down", lessonFileAnatomy)
}

const build = "dev"

// Lesson 1.1 — Read a Go File Top-Down
func lessonFileAnatomy() {
	message := "hello, go"
	fmt.Println(message, build)

	// Unused imports and locals fail compilation — Go keeps files honest.
	// Ignore a value on purpose with the blank identifier:
	value, _ := strconv.Atoi("42")
	fmt.Println("parsed:", value)

	// Better when the error matters:
	if _, err := strconv.Atoi("not-a-number"); err != nil {
		fmt.Println("the error is a value:", err)
	}
}
`,
    ),
    "m02_values_control_text.go": createWorkspaceFile(
      "m02_values_control_text.go",
      `// Module 02 · Values, Operators, Control Flow, Strings, and Runes
//
// Golang's compact value model: zero values, typed constants, explicit
// conversions, one loop keyword, simple switches, and strings as bytes.
package main

import (
	"fmt"
	"unicode/utf8"
)

func init() {
	register("2.1", "Operator Precedence: What Binds First", lessonOperatorPrecedence)
	register("2.2", "Values, Constants, and Control Flow", lessonValuesControlFlow)
	register("2.3", "Strings Are Bytes; Range Decodes Runes", lessonStringsRunes)
	register("2.4", "Functions, Multiple Returns, and Closures", lessonFunctionsClosures)
}

// Lesson 2.1 — Operator Precedence: What Binds First
// Go has unary operators and five binary precedence levels. When a line
// needs thought to parse, add parentheses — clarity beats cleverness.
func lessonOperatorPrecedence() {
	fmt.Println("2 + 3*4  =", 2+3*4)   // * binds tighter than +
	fmt.Println("(2+3)*4  =", (2+3)*4) // parentheses make intent visible
	fmt.Println("1<<3 + 1 =", 1<<3+1)  // << is multiplicative, + additive

	sunny, windy := true, false
	fmt.Println("sunny || windy && !sunny =", sunny || windy && !sunny) // && before ||
}

// Lesson 2.2 — Values, Constants, and Control Flow
func lessonValuesControlFlow() {
	var count int   // declarations start at their zero value: 0
	const limit = 3 // untyped constant, flexible until used

	for count < limit { // for is the only loop keyword: while-style...
		count++
	}
	fmt.Println("count reached:", count)

	for i := range 2 { // ...range-style, over an int since Go 1.22...
		fmt.Println("iteration", i)
	}
	// ...and "for {}" loops forever until break or return.

	switch { // a switch without a condition replaces if/else chains
	case count == limit:
		fmt.Println("exactly at the limit")
	default:
		fmt.Println("somewhere else")
	}
}

// Lesson 2.3 — Strings Are Bytes; Range Decodes Runes
// Separate byte-oriented APIs from Unicode-aware APIs.
func lessonStringsRunes() {
	s := "héllo"
	fmt.Println("len(s) counts bytes: ", len(s))
	fmt.Println("runes in s:          ", utf8.RuneCountInString(s))

	for i, r := range s { // range decodes UTF-8 into runes
		fmt.Printf("  byte offset %d -> %q\\n", i, r)
	}
}

// Lesson 2.4 — Functions, Multiple Returns, and Closures
// Functions are small boundaries with explicit inputs, outputs, and
// captured state.
func lessonFunctionsClosures() {
	quotient, remainder := divmod(7, 3)
	fmt.Println("7 / 3 =", quotient, "remainder", remainder)

	next := counter() // the closure owns its captured state
	fmt.Println("counter:", next(), next(), next())
}

func divmod(a, b int) (int, int) {
	return a / b, a % b
}

func counter() func() int {
	n := 0
	return func() int {
		n++
		return n
	}
}
`,
    ),
    "m03_collections_pointers.go": createWorkspaceFile(
      "m03_collections_pointers.go",
      `// Module 03 · Arrays, Slices, Maps, Structs, and Explicit Pointers
//
// Most early Go bugs are ownership bugs. Learn which values copy data,
// which values point at shared backing storage, and how explicit pointers
// mutate caller-owned state.
package main

import (
	"fmt"
	"maps"
	"slices"
)

func init() {
	register("3.1", "Slices Copy Headers, Not Backing Arrays", lessonSliceOwnership)
	register("3.2", "Maps: Missing Keys and Iteration Order", lessonMaps)
	register("3.3", "Structs and Arrays Are Values", lessonStructValues)
	register("3.4", "Explicit Pointers", lessonExplicitPointers)
}

// Lesson 3.1 — Slices Copy Headers, Not Backing Arrays
// Predict when two slices share the same data.
func lessonSliceOwnership() {
	raw := []string{"go", "gin", "grpc"}

	window := raw[:2]    // copies the header only
	window[0] = "gopher" // raw[0] changed too
	fmt.Println("raw after writing through window:", raw)

	safe := slices.Clone(window)
	safe[1] = "fiber" // raw is untouched
	fmt.Println("raw after writing through clone: ", raw)
	fmt.Println("safe:", safe)
}

// Lesson 3.2 — Maps: Missing Keys, Ownership, and Iteration Order
func lessonMaps() {
	stars := map[string]int{"go": 130000, "gin": 84000}

	fmt.Println("missing key yields the zero value:", stars["fiber"])
	if _, ok := stars["fiber"]; !ok {
		fmt.Println("comma-ok tells absence apart from a real zero")
	}

	// Iteration order is unspecified on purpose — never depend on it.
	// When order matters, sort the keys (Go 1.23 maps + slices):
	for _, name := range slices.Sorted(maps.Keys(stars)) {
		fmt.Printf("  %s: %d\\n", name, stars[name])
	}
}

// Lesson 3.3 — Structs and Arrays Are Values
// Model data with structs while staying clear about value copies.
type user struct {
	Name string
}

func lessonStructValues() {
	alice := user{Name: "Alice"}

	copied := alice // structs copy on assignment...
	copied.Name = "Mallory"
	fmt.Println("the original is unchanged:", alice.Name)
	fmt.Println("only the copy renamed:    ", copied.Name)
}

// Lesson 3.4 — Explicit Pointers: Address, Dereference, Nil, and Mutation
// A pointer is an ordinary value that stores an address.
func lessonExplicitPointers() {
	alice := user{Name: "Alice"}

	rename(&alice, "Alicia") // pass the address to mutate caller-owned state
	fmt.Println("after rename:", alice.Name)

	var nobody *user // pointers have a zero value too
	fmt.Println("a nil pointer is a valid value:", nobody == nil)
}

func rename(u *user, name string) {
	u.Name = name // mutates caller-owned state
}
`,
    ),
    "m04_methods_interfaces_generics.go": createWorkspaceFile(
      "m04_methods_interfaces_generics.go",
      `// Module 04 · Methods, Interfaces, and Generics
//
// Go composition depends on named types, receiver choices, tiny
// interfaces, and generics that remove real duplication.
package main

import (
	"fmt"
	"iter"
	"strings"
)

func init() {
	register("4.1", "Methods Attach Behavior to Named Types", lessonMethodsReceivers)
	register("4.2", "Interfaces Carry Dynamic Type and Value", lessonInterfaces)
	register("4.3", "Iterators and the Yield Pattern", lessonIterators)
}

// Lesson 4.1 — Methods Attach Behavior to Named Types
// Choose value and pointer receivers based on mutation and copying.
type tally struct{ hits int }

func (t tally) peek() int { return t.hits } // value receiver: reads a copy

func (t *tally) hit() { t.hits++ } // pointer receiver: mutates the original

func lessonMethodsReceivers() {
	var t tally
	t.hit()
	t.hit()
	fmt.Println("hits recorded through the pointer receiver:", t.peek())
}

// Lesson 4.2 — Interfaces Carry Dynamic Type and Value
// Keep interfaces tiny, and watch for the typed-nil trap.
type speaker interface{ speak() string }

type dog struct{}

func (dog) speak() string { return "woof" }

func lessonInterfaces() {
	var s speaker = dog{}
	fmt.Printf("dynamic type %T says %q\\n", s, s.speak())

	// The typed-nil trap: an interface holding a nil pointer is not nil —
	// it still carries a dynamic type.
	var p *strings.Reader
	var boxed any = p
	fmt.Println("boxed == nil?", boxed == nil)
}

// Lesson 4.3 — Iterators and the Yield Pattern (Go 1.23 range-over-func)
// yield is a callback convention, not a keyword.
func countTo(n int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for i := range n {
			if !yield(i) {
				return
			}
		}
	}
}

func lessonIterators() {
	for v := range countTo(3) {
		fmt.Println("yielded", v)
	}

	// Generics remove real duplication — one mapSlice for every type pair.
	bars := mapSlice([]int{1, 2, 3}, func(n int) string {
		return strings.Repeat("*", n)
	})
	fmt.Println("mapped:", bars)
}

func mapSlice[T, U any](in []T, f func(T) U) []U {
	out := make([]U, 0, len(in))
	for _, v := range in {
		out = append(out, f(v))
	}
	return out
}
`,
    ),
    "m05_errors_packages_testing.go": createWorkspaceFile(
      "m05_errors_packages_testing.go",
      `// Module 05 · Errors, Defer, Packages, Modules, and Testing
//
// Professional Go makes failure explicit, keeps package boundaries small,
// tests behavior with data, and uses the toolchain every day.
package main

import (
	"errors"
	"fmt"
)

func init() {
	register("5.1", "Errors Are Values in the API", lessonErrorsDefer)
	register("5.2", "Packages, Modules, and the Quality Loop", lessonQualityLoop)
}

var errEmptyConfig = errors.New("empty config")

// Lesson 5.1 — Errors Are Values in the API
// Return errors that callers can inspect without parsing strings.
func loadConfig(contents string) error {
	if contents == "" {
		return fmt.Errorf("read config %q: %w", "app.yaml", errEmptyConfig)
	}
	return nil
}

func lessonErrorsDefer() {
	defer fmt.Println("defer ran last — cleanup lives next to acquisition")

	err := loadConfig("")
	fmt.Println("wrapped:", err)
	fmt.Println("errors.Is finds the cause through %w:", errors.Is(err, errEmptyConfig))
}

// Lesson 5.2 — Packages, Modules, and the Quality Loop
// go test runs functions like TestAdd in _test.go files; the table below
// is the default shape — behavior expressed as data. The same loop runs
// here so you can watch it work, then recreate it locally with go test.
func lessonQualityLoop() {
	cases := []struct {
		name string
		a, b int
		want int
	}{
		{name: "positive", a: 1, b: 2, want: 3},
		{name: "negative", a: -1, b: -2, want: -3},
		{name: "mixed", a: 5, b: -2, want: 3},
	}

	for _, tc := range cases {
		got := tc.a + tc.b
		status := "ok"
		if got != tc.want {
			status = "FAIL"
		}
		fmt.Printf("  %-10s got %3d want %3d  %s\\n", tc.name, got, tc.want, status)
	}
	fmt.Println("keep packages small; run gofmt, go vet, and go test daily")
}
`,
    ),
    "m06_stdlib_boundaries.go": createWorkspaceFile(
      "m06_stdlib_boundaries.go",
      `// Module 06 · I/O, Encoding, HTTP, Time, Context, Logging, and Databases
//
// The standard library is a production toolkit. Learn the interfaces and
// packages that compose before reaching for frameworks.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"
)

func init() {
	register("6.1", "Readers and Writers Snap Together", lessonReadersWriters)
	register("6.2", "HTTP, Time, Logging, and Database Boundaries", lessonStdlibBoundaries)
}

// Lesson 6.1 — Readers and Writers Make Packages Snap Together
// Use the I/O interfaces before inventing wrappers.
func lessonReadersWriters() {
	// Anything implementing io.Reader plugs into anything accepting one.
	banner := strings.NewReader("io.Reader -> io.Writer, no wrappers needed\\n")
	if _, err := io.Copy(os.Stdout, banner); err != nil {
		fmt.Println("copy failed:", err)
	}

	// Encoders write to any io.Writer — a file, a socket, or stdout.
	payload := map[string]any{"lesson": "6.1", "composes": true}
	if err := json.NewEncoder(os.Stdout).Encode(payload); err != nil {
		fmt.Println("encode failed:", err)
	}
}

// Lesson 6.2 — HTTP, Time, Logging, and Database Boundaries
// Carry deadlines, structured logs, and lookups through explicit
// standard-library boundaries.
type userStore interface {
	find(id string) (string, bool)
}

type memoryStore map[string]string

func (m memoryStore) find(id string) (string, bool) {
	name, ok := m[id]
	return name, ok
}

func handleUser(logger *slog.Logger, users userStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		name, ok := users.find(id)
		if !ok {
			logger.Error("find user", "id", id)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		fmt.Fprintf(w, "hello, %s\\n", name)
	}
}

func lessonStdlibBoundaries() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	mux := http.NewServeMux()
	mux.Handle("GET /users/{id}", handleUser(logger, memoryStore{"1": "Ada"}))

	// httptest exercises the handler fully in memory — no sockets, and the
	// exact same contract a live server would use.
	for _, path := range []string{"/users/1", "/users/404"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		fmt.Printf("GET %s -> %d %s", path, rec.Code, rec.Body.String())
	}

	launch := time.Date(2026, 1, 2, 15, 4, 5, 0, time.UTC)
	fmt.Println("time boundaries are explicit:", launch.Format(time.RFC3339))

	// database/sql follows the same shape: QueryRowContext(ctx, ...) carries
	// the caller's lifetime into the driver. Swap memoryStore for a real
	// store later — the handler above never has to change.
}
`,
    ),
    "m07_concurrency_primitives.go": createWorkspaceFile(
      "m07_concurrency_primitives.go",
      `// Module 07 · Goroutines, Channels, Select, and Synchronization
//
// Concurrency starts with lifetime and ownership. Channels transfer
// ownership of data; locks protect memory in place.
package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

func init() {
	register("7.1", "Unbuffered Channels Are Handoff Points", lessonChannelRendezvous)
	register("7.2", "WaitGroups, Mutexes, and Race Detection", lessonSyncPrimitives)
}

// Lesson 7.1 — Unbuffered Channels Are Handoff Points
// Avoid the beginner deadlock: start the receiver before you send.
func lessonChannelRendezvous() {
	results := make(chan int)
	received := make(chan struct{})

	go func() { // the receiver runs BEFORE the send below...
		fmt.Println("received:", <-results)
		close(received)
	}()

	results <- 42 // ...otherwise this handoff would block forever
	<-received

	fmt.Println("select adds timeouts and cancellation:")
	if err := waitForResult(context.Background()); err != nil {
		fmt.Println("  ", err)
	}
}

func waitForResult(ctx context.Context) error {
	results := make(chan int) // nobody sends here: the timeout case wins
	select {
	case r := <-results:
		fmt.Println("  result:", r)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(50 * time.Millisecond):
		return errors.New("worker timeout")
	}
}

// Lesson 7.2 — WaitGroups, Mutexes, and Race Detection
// Pick the primitive by need: completion, memory protection, or choice.
func lessonSyncPrimitives() {
	var (
		mu    sync.Mutex
		total int
		wg    sync.WaitGroup
	)

	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done() // the WaitGroup proves completion
			mu.Lock()       // the Mutex protects shared memory
			total += 25
			mu.Unlock()
		}()
	}

	wg.Wait()
	fmt.Println("total:", total)
	fmt.Println("locally, go test -race proves the locking is right")
}
`,
    ),
    "m08_concurrency_systems.go": createWorkspaceFile(
      "m08_concurrency_systems.go",
      `// Module 08 · Context, Worker Pools, Pipelines, and Graceful Shutdown
//
// Real systems need bounded concurrency, backpressure, cancellation
// propagation, and deterministic shutdown — not unlimited goroutine
// fan-out.
package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

func init() {
	register("8.1", "Context Is a Lifetime Signal", lessonContextCancellation)
	register("8.2", "Bounded Worker Pools and Graceful Shutdown", lessonWorkerPool)
}

// Lesson 8.1 — Context Is a Lifetime Signal
// Stop work promptly when the caller no longer needs it.
func lessonContextCancellation() {
	ctx, cancel := context.WithCancel(context.Background())

	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for tick := 1; ; tick++ {
			select {
			case <-ctx.Done():
				fmt.Println("worker: stopping —", ctx.Err())
				return
			default:
				fmt.Println("worker: tick", tick)
				time.Sleep(10 * time.Millisecond)
			}
		}
	}()

	time.Sleep(25 * time.Millisecond)
	cancel() // the caller is done; the worker must notice promptly
	<-stopped
}

// Lesson 8.2 — Bounded Worker Pools and Graceful Shutdown
// Limit concurrency, close outputs deterministically, and let
// cancellation stop the pipeline. Completion order may vary between
// workers — that is the point.
type job struct{ id int }

type poolResult struct{ msg string }

func runPool(ctx context.Context, jobs <-chan job, workers int) <-chan poolResult {
	results := make(chan poolResult)
	var wg sync.WaitGroup

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case j, ok := <-jobs:
					if !ok {
						return // jobs channel closed: drain complete
					}
					select {
					case results <- poolResult{msg: fmt.Sprintf("job %d done", j.id)}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	go func() {
		wg.Wait()      // every worker has returned...
		close(results) // ...so closing results is safe and deterministic
	}()

	return results
}

func lessonWorkerPool() {
	ctx := context.Background()

	jobs := make(chan job)
	go func() {
		defer close(jobs) // closing jobs lets the pool drain gracefully
		for i := 1; i <= 5; i++ {
			jobs <- job{id: i}
		}
	}()

	done := 0
	for r := range runPool(ctx, jobs, 2) {
		fmt.Println(r.msg)
		done++
	}
	fmt.Println("pool drained after", done, "jobs — bounded, not unlimited")
}
`,
    ),
    "m09_runtime_performance.go": createWorkspaceFile(
      "m09_runtime_performance.go",
      `// Module 09 · Scheduler, Escape Analysis, GC, Profiling, and Memory Layout
//
// Performance work starts with measurement and a concrete model of what
// the runtime, allocator, garbage collector, and CPU are doing.
package main

import (
	"bytes"
	"fmt"
	"runtime"
	"slices"
	"sync"
	"testing"
)

func init() {
	register("9.1", "The Runtime Is Part of the Program", lessonRuntimeModel)
	register("9.2", "Benchmark, Profile, Then Change", lessonMeasurementLoop)
	register("9.3", "Goroutine Stack Economics", lessonStackEconomics)
}

// Lesson 9.1 — The Runtime Is Part of the Program
func lessonRuntimeModel() {
	fmt.Println("go version:    ", runtime.Version())
	fmt.Println("GOMAXPROCS:    ", runtime.GOMAXPROCS(0), "of", runtime.NumCPU(), "CPUs")
	fmt.Println("live goroutines:", runtime.NumGoroutine())

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("heap in use: %d KiB across %d objects\\n", m.HeapAlloc/1024, m.HeapObjects)
}

// Lesson 9.2 — Benchmark, Profile, Then Change
// The real loop is: go test -bench=. -benchmem, then pprof, then edit.
// testing.Benchmark runs the same measurement inside a program:
func lessonMeasurementLoop() {
	src := bytes.Repeat([]byte("go"), 512)

	res := testing.Benchmark(func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = slices.Clone(src)
		}
	})

	fmt.Println("iterations:", res.N)
	fmt.Println("ns/op:     ", res.NsPerOp())
	fmt.Println("allocs/op: ", res.AllocsPerOp(), " bytes/op:", res.AllocedBytesPerOp())
	fmt.Println("measure first; only then change the code")
}

// Lesson 9.3 — Goroutine Stack Economics
// Goroutine stacks start small and grow on demand — cheap, but never free.
func lessonStackEconomics() {
	const parked = 10000

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	release := make(chan struct{})
	var wg sync.WaitGroup
	for range parked {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-release // parked until the measurement is done
		}()
	}

	var after runtime.MemStats
	runtime.ReadMemStats(&after)

	perGoroutine := int64(after.StackInuse-before.StackInuse) / parked
	fmt.Printf("%d parked goroutines use ~%d KiB of stack each\\n", parked, perGoroutine/1024)

	close(release)
	wg.Wait()
	fmt.Println("released — lifetime always has an owner")
}
`,
    ),
    "m10_advanced_boundaries.go": createWorkspaceFile(
      "m10_advanced_boundaries.go",
      `// Module 10 · Reflection, Unsafe, Build Tags, cgo, and Production Boundaries
//
// Sharp tools are legitimate — fence them off behind small APIs so most of
// the codebase remains ordinary Go.
package main

import (
	"fmt"
	"reflect"
	"unsafe"
)

func init() {
	register("10.1", "Fence Off Sharp Tools", lessonAdvancedFences)
	register("10.2", "Reflection, Unsafe, and cgo Stay Small", lessonBoundaryTools)
}

type record struct {
	ID   int32
	Live bool
	Name string
}

// Lesson 10.1 — Fence Off Sharp Tools
// describeStruct is this file's entire reflection surface: one small,
// well-named function that other code calls without importing reflect.
func describeStruct(v any) {
	t := reflect.TypeOf(v)
	fmt.Printf("%s has %d fields:\\n", t.Name(), t.NumField())
	for i := range t.NumField() {
		f := t.Field(i)
		fmt.Printf("  %-5s %-6s offset %d bytes\\n", f.Name, f.Type, f.Offset)
	}
}

func lessonAdvancedFences() {
	describeStruct(record{})
	fmt.Println("callers stay ordinary Go — the sharp tool is contained")
}

// Lesson 10.2 — Reflection, Unsafe, and cgo Stay Small
// The field offsets above come from memory layout — unsafe can read it,
// and padding is why struct layout is a performance topic.
func lessonBoundaryTools() {
	var r record
	fmt.Println("unsafe.Sizeof(record): ", unsafe.Sizeof(r), "bytes")
	fmt.Println("unsafe.Alignof(record):", unsafe.Alignof(r))
	fmt.Println("Live sits at byte 4; Name starts at byte 8 — padding fills 5-7")

	// Build tags (//go:build) and cgo cross the same fence: isolate them in
	// one package with a plain-Go fallback, and keep every caller ordinary.
}
`,
    ),
    "COURSE.md": createWorkspaceFile(
      "COURSE.md",
      `# Golang: From Source Files to Production

The lesson workspace for the practical Go course at
**golang-dev.vercel.app/courses/go** — 6 parts, 10 modules, 25 lessons,
targeting Go 1.23+.

## How to use this workspace

1. Open \`main.go\` and set \`currentLesson\` to a lesson key (e.g. \`"3.1"\`).
2. Press **Run** — the lesson demo prints its output here.
3. Open the matching \`m*.go\` file, edit the lesson function, run again.
4. Press **Format** any time — it runs gofmt across every file.
5. Set \`currentLesson\` to \`"all"\` to run the whole course top to bottom.

## Reading path

| Part | Module file | Lessons |
| --- | --- | --- |
| 01 · Language Core | \`m01_files_packages_tooling.go\` | 1.1 Read a Go File Top-Down |
| 01 · Language Core | \`m02_values_control_text.go\` | 2.1 Operator Precedence · 2.2 Values, Constants, Control Flow · 2.3 Strings and Runes · 2.4 Functions and Closures |
| 02 · Types, Data, and Memory | \`m03_collections_pointers.go\` | 3.1 Slice Ownership · 3.2 Maps · 3.3 Structs Are Values · 3.4 Explicit Pointers |
| 02 · Types, Data, and Memory | \`m04_methods_interfaces_generics.go\` | 4.1 Methods and Receivers · 4.2 Interfaces · 4.3 Iterators and Yield |
| 03 · Errors, Packages, Quality | \`m05_errors_packages_testing.go\` | 5.1 Errors Are Values · 5.2 The Quality Loop |
| 04 · Standard Library Fluency | \`m06_stdlib_boundaries.go\` | 6.1 Readers and Writers · 6.2 HTTP, Time, Logging, Databases |
| 05 · Concurrency | \`m07_concurrency_primitives.go\` | 7.1 Channel Rendezvous · 7.2 WaitGroups, Mutexes, Race |
| 05 · Concurrency | \`m08_concurrency_systems.go\` | 8.1 Context Cancellation · 8.2 Bounded Worker Pools |
| 06 · Runtime and Advanced Go | \`m09_runtime_performance.go\` | 9.1 The Runtime Model · 9.2 Benchmark, Profile, Change · 9.3 Goroutine Stacks |
| 06 · Runtime and Advanced Go | \`m10_advanced_boundaries.go\` | 10.1 Fence Off Sharp Tools · 10.2 Sharp Tools Stay Small |

## Notes

- Every \`.go\` file here runs together as one \`package main\` program.
  Each module file registers its own lessons with the runner in \`main.go\`
  from an \`init\` func, so a lesson's key, title, and demo stay together.
- The Run button executes through the Go Playground, so there is no
  network or filesystem — lessons that need them (live HTTP servers,
  \`database/sql\`, pprof, \`-race\`) demonstrate the pattern in memory and
  tell you what to run locally.
- New to Go? Warm up with *A Tour of Go* first, then come back.
`,
    ),
  };

  return {
    id: "go-workspace",
    name: "Go Lesson",
    lessonType: "go",
    entryFilePath: "main.go",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
