package main

import (
	"archive/zip"
	"bytes"
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
