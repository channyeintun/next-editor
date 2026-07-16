package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func makeTraversalZip(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("../oops")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("x"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func makeSymlinkTraversalZip(t *testing.T, target string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "link"}
	header.SetMode(os.ModeSymlink | 0o777)
	link, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = link.Write([]byte(target))
	file, err := writer.Create("link/escaped.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write([]byte("escape"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestUnpackZipRejectsTraversalThroughArchiveSymlink(t *testing.T) {
	outside := t.TempDir()
	destination := t.TempDir()
	data := makeSymlinkTraversalZip(t, outside)
	if err := unpackZip(bytes.NewReader(data), int64(len(data)), destination); err == nil {
		t.Fatal("accepted a file nested beneath an archive symlink")
	}
	if _, err := os.Stat(filepath.Join(outside, "escaped.txt")); !os.IsNotExist(err) {
		t.Fatalf("archive wrote outside destination: %v", err)
	}
}
