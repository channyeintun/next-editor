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
