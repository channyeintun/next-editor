package main

import (
	"bytes"
	"os"
	"path/filepath"
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
}

func TestUnpackZipRejectsTraversal(t *testing.T) {
	data := makeTraversalZip(t)
	if err := unpackZip(bytes.NewReader(data), int64(len(data)), t.TempDir()); err == nil {
		t.Fatal("accepted traversal zip")
	}
}
