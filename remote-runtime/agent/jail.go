package main

import (
	"archive/zip"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type jail struct{ root string }

func newJail(root string) jail { return jail{root: filepath.Clean(root)} }

func (j jail) resolve(name string, allowMissing bool) (string, error) {
	name = filepath.FromSlash(name)
	if filepath.IsAbs(name) {
		return "", fail("EACCES", "absolute paths are not allowed")
	}
	clean := filepath.Clean(name)
	if clean != "." && len(strings.Split(filepath.ToSlash(clean), "/")) > 64 {
		return "", fail("ELIMIT", "path depth exceeds 64 components")
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fail("EACCES", "path escapes workspace")
	}
	joined := filepath.Join(j.root, clean)
	check := joined
	if allowMissing {
		check = filepath.Dir(joined)
	}
	existing := check
	for {
		_, statErr := os.Lstat(existing)
		if statErr == nil {
			break
		}
		if !errors.Is(statErr, fs.ErrNotExist) {
			return "", mapFsError(statErr)
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", fail("EACCES", "cannot resolve workspace path")
		}
		existing = parent
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", mapFsError(err)
	}
	rel, err := filepath.Rel(j.root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fail("EACCES", "symlink escapes workspace")
	}
	return joined, nil
}

func mapFsError(err error) error {
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "directory not empty"):
		return fail("ENOTEMPTY", err.Error())
	case strings.Contains(text, "not a directory"):
		return fail("ENOTDIR", err.Error())
	case strings.Contains(text, "is a directory"):
		return fail("EISDIR", err.Error())
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return fail("ENOENT", err.Error())
	case errors.Is(err, fs.ErrExist):
		return fail("EEXIST", err.Error())
	case errors.Is(err, fs.ErrPermission):
		return fail("EACCES", err.Error())
	default:
		return fail("EPROTO", err.Error())
	}
}

func unpackZip(r io.ReaderAt, size int64, destination string) error {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return fail("EPROTO", "invalid mount zip")
	}
	for _, member := range zr.File {
		name := filepath.Clean(filepath.FromSlash(member.Name))
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fail("EACCES", "zip entry escapes mount point")
		}
		target := filepath.Join(destination, name)
		if member.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return mapFsError(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return mapFsError(err)
		}
		rc, err := member.Open()
		if err != nil {
			return mapFsError(err)
		}
		if member.Mode()&os.ModeSymlink != 0 {
			data, readErr := io.ReadAll(io.LimitReader(rc, 4097))
			_ = rc.Close()
			if readErr != nil || len(data) > 4096 {
				return fail("ELIMIT", "invalid symlink")
			}
			if err := os.Symlink(string(data), target); err != nil {
				return mapFsError(err)
			}
			continue
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			_ = rc.Close()
			return mapFsError(err)
		}
		_, copyErr := io.Copy(out, io.LimitReader(rc, maxFileBytes+1))
		closeErr := out.Close()
		_ = rc.Close()
		if copyErr != nil {
			return mapFsError(copyErr)
		}
		if closeErr != nil {
			return mapFsError(closeErr)
		}
	}
	return nil
}
