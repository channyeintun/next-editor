package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestBinaryFrameRoundTrip(t *testing.T) {
	encoded, err := binaryFrame(7, []byte("hello"), true)
	if err != nil {
		t.Fatal(err)
	}
	channel, payload, fin, err := parseBinaryFrame(encoded)
	if err != nil || channel != 7 || !fin || !bytes.Equal(payload, []byte("hello")) {
		t.Fatalf("unexpected frame: %d %q %v %v", channel, payload, fin, err)
	}
}

func TestJailRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	j := newJail(root)
	if _, err := j.resolve("../outside", true); err == nil {
		t.Fatal("accepted parent escape")
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := j.resolve("link/file", true); err == nil {
		t.Fatal("accepted symlink escape")
	}
	if err := os.Mkdir(filepath.Join(root, "safe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "safe", "nested-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := j.resolve("safe/nested-link/missing/child", true); err == nil {
		t.Fatal("accepted missing path beneath symlink escape")
	}
	outsideFile := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(root, "final-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := j.resolve("final-link", true); err == nil {
		t.Fatal("accepted a final symlink escaping the workspace for a following operation")
	}
	if got, err := j.resolveEntry("final-link", false); err != nil || got != filepath.Join(root, "final-link") {
		t.Fatalf("could not resolve the symlink entry itself: %q %v", got, err)
	}
	absoluteInside := filepath.Join(root, "safe", "file.txt")
	if got, err := j.resolve(absoluteInside, true); err != nil || got != absoluteInside {
		t.Fatalf("workspace absolute path did not round-trip: %q %v", got, err)
	}
	if _, err := j.resolve(outsideFile, false); err == nil {
		t.Fatal("accepted an absolute path outside the workspace")
	}
}

func TestFilesystemErrnoMapping(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, code string
		err        error
	}{
		{"missing", "ENOENT", func() error { _, err := os.ReadFile(filepath.Join(root, "missing")); return err }()},
		{"existing", "EEXIST", os.Mkdir(filepath.Join(root, "dir"), 0o755)},
		{"not-empty", "ENOTEMPTY", os.Remove(filepath.Join(root, "dir"))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mapped := mapFsError(tc.err)
			re, ok := mapped.(*rcpError)
			if !ok || re.code != tc.code {
				t.Fatalf("got %v, want %s", mapped, tc.code)
			}
		})
	}
}

func TestSignaledExitCode(t *testing.T) {
	cmd := exec.Command("sh", "-c", "kill -TERM $$")
	err := cmd.Run()
	if code := processExitCode(err); code != 128+int(syscall.SIGTERM) {
		t.Fatalf("got %d", code)
	}
}

func TestProcessLimitCountsOnlyActiveProcesses(t *testing.T) {
	exited := 0
	a := &agent{processes: map[int]*runningProcess{
		1: {id: 1},
		2: {id: 2, exitCode: &exited},
	}}
	a.mu.Lock()
	count := a.activeProcessCountLocked()
	a.mu.Unlock()
	if count != 1 {
		t.Fatalf("counted %d active processes, want 1", count)
	}
}

func TestEstablishedSessionRequiresResumeToken(t *testing.T) {
	a := newAgent(t.TempDir(), 8600)
	first := &session{agent: a}
	params := []byte(`{"protocolVersion":1}`)
	if _, err := first.dispatch(request{Method: "session.hello", Params: params}); err != nil {
		t.Fatal(err)
	}
	second := &session{agent: a}
	if _, err := second.dispatch(request{Method: "session.hello", Params: params}); err == nil ||
		!strings.HasPrefix(err.Error(), "EGONE:") {
		t.Fatalf("fresh attach replaced an established session: %v", err)
	}
}

func TestJailPathDepthLimit(t *testing.T) {
	j := newJail(t.TempDir())
	deep := strings.Repeat("dir/", 64) + "file"
	if _, err := j.resolve(deep, true); err == nil || !strings.HasPrefix(err.Error(), "ELIMIT:") {
		t.Fatalf("got %v", err)
	}
}

func FuzzParseBinaryFrame(f *testing.F) {
	valid, _ := binaryFrame(7, []byte("seed"), true)
	f.Add(valid)
	f.Add([]byte{0, 0, 0, 0, 0})
	f.Fuzz(func(t *testing.T, data []byte) {
		channel, payload, _, err := parseBinaryFrame(data)
		if err == nil {
			if channel == 0 {
				t.Fatal("accepted reserved channel")
			}
			if len(payload) > maxBinaryPayload {
				t.Fatal("accepted oversized payload")
			}
		}
	})
}

func TestExportGlobs(t *testing.T) {
	if !matchesExportPath("src/main.go", []string{"src/**"}, []string{"**/*.test.go"}) {
		t.Fatal("expected include")
	}
	if matchesExportPath("src/main.test.go", []string{"src/**"}, []string{"**/*.test.go"}) {
		t.Fatal("expected exclude")
	}
	if matchesExportPath("README.md", []string{"src/**"}, nil) {
		t.Fatal("unexpected include")
	}
}

func TestUnpackZipRejectsTraversal(t *testing.T) {
	data := makeTraversalZip(t)
	if err := unpackZip(bytes.NewReader(data), int64(len(data)), t.TempDir()); err == nil {
		t.Fatal("accepted traversal zip")
	}
}
