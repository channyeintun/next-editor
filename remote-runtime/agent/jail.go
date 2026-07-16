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

func newJail(root string) jail {
	root, err := filepath.Abs(root)
	if err != nil {
		panic(err)
	}
	if real, evalErr := filepath.EvalSymlinks(root); evalErr == nil {
		root = real
	}
	return jail{root: filepath.Clean(root)}
}

func (j jail) resolve(name string, allowMissing bool) (string, error) {
	return j.resolveWithFinal(name, allowMissing, true)
}

// resolveEntry verifies every parent but deliberately does not follow the final
// component. It is for operations such as rm and rename that manipulate a
// symlink itself rather than the symlink's target.
func (j jail) resolveEntry(name string, allowMissing bool) (string, error) {
	return j.resolveWithFinal(name, allowMissing, false)
}

func (j jail) resolveWithFinal(name string, allowMissing, followFinal bool) (string, error) {
	name = filepath.Clean(filepath.FromSlash(name))
	if filepath.IsAbs(name) {
		rel, err := filepath.Rel(j.root, name)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", fail("EACCES", "absolute path escapes workspace")
		}
		name = rel
	}
	clean := name
	if clean != "." && len(strings.Split(filepath.ToSlash(clean), "/")) > 64 {
		return "", fail("ELIMIT", "path depth exceeds 64 components")
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fail("EACCES", "path escapes workspace")
	}
	joined := filepath.Join(j.root, clean)
	check := joined
	if !followFinal {
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
		if existing == check && !allowMissing {
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

func ensureArchiveDirectory(destination, relative string) (string, error) {
	current := destination
	for _, part := range strings.Split(filepath.Clean(relative), string(filepath.Separator)) {
		if part == "." || part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			if err := os.Mkdir(current, 0o755); err != nil {
				return "", mapFsError(err)
			}
			continue
		}
		if err != nil {
			return "", mapFsError(err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", fail("EACCES", "zip entry traverses a non-directory")
		}
	}
	return current, nil
}

func unpackZip(r io.ReaderAt, size int64, destination string) error {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return fail("EPROTO", "invalid mount zip")
	}
	seen := make(map[string]bool, len(zr.File))
	var expanded int64
	for _, member := range zr.File {
		name := filepath.Clean(filepath.FromSlash(member.Name))
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fail("EACCES", "zip entry escapes mount point")
		}
		if name == "." || len(strings.Split(filepath.ToSlash(name), "/")) > 64 {
			return fail("ELIMIT", "zip entry path exceeds 64 components")
		}
		if seen[name] {
			return fail("EPROTO", "duplicate zip entry")
		}
		seen[name] = true
		if member.UncompressedSize64 > uint64(maxFileBytes) && !member.FileInfo().IsDir() && member.Mode()&os.ModeSymlink == 0 {
			return fail("ELIMIT", "mounted file exceeds 64 MiB")
		}
		if member.UncompressedSize64 > uint64(maxMountBytes)-uint64(expanded) {
			return fail("ELIMIT", "expanded mount exceeds 256 MiB")
		}
		expanded += int64(member.UncompressedSize64)
		target := filepath.Join(destination, name)
		parent, parentErr := ensureArchiveDirectory(destination, filepath.Dir(name))
		if parentErr != nil {
			return parentErr
		}
		if parent != filepath.Dir(target) {
			return fail("EACCES", "zip entry escapes mount point")
		}
		if member.FileInfo().IsDir() {
			if _, err := ensureArchiveDirectory(destination, name); err != nil {
				return err
			}
			continue
		}
		if _, err := os.Lstat(target); err == nil {
			return fail("EPROTO", "zip path collision")
		} else if !errors.Is(err, fs.ErrNotExist) {
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
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			_ = rc.Close()
			return mapFsError(err)
		}
		written, copyErr := io.Copy(out, io.LimitReader(rc, maxFileBytes+1))
		closeErr := out.Close()
		_ = rc.Close()
		if copyErr != nil {
			return mapFsError(copyErr)
		}
		if written > maxFileBytes {
			return fail("ELIMIT", "mounted file exceeds 64 MiB")
		}
		if closeErr != nil {
			return mapFsError(closeErr)
		}
	}
	return nil
}

// mergeMount moves a fully validated staging tree into the destination. A
// missing destination is one atomic rename; an existing mount point is merged
// without ever following destination symlinks.
func mergeMount(source, destination string) error {
	if _, err := os.Lstat(destination); errors.Is(err, fs.ErrNotExist) {
		if err := os.Rename(source, destination); err != nil {
			return mapFsError(err)
		}
		return nil
	} else if err != nil {
		return mapFsError(err)
	}
	destinationInfo, err := os.Lstat(destination)
	if err != nil {
		return mapFsError(err)
	}
	if !destinationInfo.IsDir() || destinationInfo.Mode()&os.ModeSymlink != 0 {
		if err := os.RemoveAll(destination); err != nil {
			return mapFsError(err)
		}
		if err := os.Rename(source, destination); err != nil {
			return mapFsError(err)
		}
		return nil
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return mapFsError(err)
	}
	for _, entry := range entries {
		from := filepath.Join(source, entry.Name())
		to := filepath.Join(destination, entry.Name())
		fromInfo, err := os.Lstat(from)
		if err != nil {
			return mapFsError(err)
		}
		toInfo, toErr := os.Lstat(to)
		if fromInfo.IsDir() && fromInfo.Mode()&os.ModeSymlink == 0 && toErr == nil && toInfo.IsDir() && toInfo.Mode()&os.ModeSymlink == 0 {
			if err := mergeMount(from, to); err != nil {
				return err
			}
			if err := os.Remove(from); err != nil {
				return mapFsError(err)
			}
			continue
		}
		if toErr == nil {
			if err := os.RemoveAll(to); err != nil {
				return mapFsError(err)
			}
		} else if !errors.Is(toErr, fs.ErrNotExist) {
			return mapFsError(toErr)
		}
		if err := os.Rename(from, to); err != nil {
			return mapFsError(err)
		}
	}
	return nil
}
