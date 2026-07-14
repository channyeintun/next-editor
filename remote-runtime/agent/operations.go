package main

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/creack/pty"
)

func (s *session) readFile(req request) (any, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	path, err := s.agent.root.resolve(p.Path, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, mapFsError(err)
	}
	if info.IsDir() {
		return nil, fail("EISDIR", "cannot read a directory")
	}
	if info.Size() > maxFileBytes {
		return nil, fail("ELIMIT", "file exceeds 64 MiB")
	}
	channel := s.allocateChannel()
	go func() {
		file, openErr := os.Open(path)
		if openErr != nil {
			s.writeText(event("fatal", map[string]string{"message": openErr.Error()}))
			return
		}
		defer file.Close()
		buffer := make([]byte, maxBinaryPayload)
		for {
			n, readErr := file.Read(buffer)
			if n > 0 {
				if s.writeBinary(channel, buffer[:n], false) != nil {
					return
				}
			}
			if readErr == io.EOF {
				_ = s.writeBinary(channel, nil, true)
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	return map[string]any{"ch": channel}, nil
}

func (s *session) mkdir(req request) (any, error) {
	var p struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	path, err := s.agent.root.resolve(p.Path, true)
	if err != nil {
		return nil, err
	}
	if p.Recursive {
		err = os.MkdirAll(path, 0o755)
	} else {
		err = os.Mkdir(path, 0o755)
	}
	if err != nil {
		return nil, mapFsError(err)
	}
	return map[string]any{"created": p.Path}, nil
}

func (s *session) readdir(req request) (any, error) {
	var p struct {
		Path          string `json:"path"`
		WithFileTypes bool   `json:"withFileTypes"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	path, err := s.agent.root.resolve(p.Path, false)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(path)
	if err != nil {
		return nil, mapFsError(err)
	}
	entries := make([]map[string]string, 0, len(items))
	for _, item := range items {
		kind := "file"
		if item.IsDir() {
			kind = "dir"
		} else if item.Type()&os.ModeSymlink != 0 {
			kind = "symlink"
		}
		entries = append(entries, map[string]string{"name": item.Name(), "kind": kind})
	}
	return map[string]any{"entries": entries}, nil
}

func (s *session) remove(req request) (any, error) {
	var p struct {
		Path             string `json:"path"`
		Recursive, Force bool
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	path, err := s.agent.root.resolve(p.Path, p.Force)
	if err != nil {
		if p.Force {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if p.Recursive {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil && !p.Force {
		return nil, mapFsError(err)
	}
	return map[string]any{}, nil
}

func (s *session) rename(req request) (any, error) {
	var p struct{ From, To string }
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	from, err := s.agent.root.resolve(p.From, false)
	if err != nil {
		return nil, err
	}
	to, err := s.agent.root.resolve(p.To, true)
	if err != nil {
		return nil, err
	}
	if err := os.Rename(from, to); err != nil {
		return nil, mapFsError(err)
	}
	return map[string]any{}, nil
}

type fileStamp struct {
	mod  int64
	size int64
	mode os.FileMode
}

func snapshot(root string, recursive bool) map[string]fileStamp {
	result := map[string]fileStamp{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if path == root {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		result[filepath.ToSlash(rel)] = fileStamp{info.ModTime().UnixNano(), info.Size(), info.Mode()}
		if info.IsDir() && !recursive {
			return filepath.SkipDir
		}
		return nil
	})
	return result
}

func (s *session) watch(req request) (any, error) {
	var p struct {
		WatchID   int    `json:"watchId"`
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	path, err := s.agent.root.resolve(p.Path, false)
	if err != nil {
		return nil, err
	}
	s.agent.mu.Lock()
	if len(s.agent.watches) >= maxWatches {
		s.agent.mu.Unlock()
		return nil, fail("ELIMIT", "watch limit reached")
	}
	if old := s.agent.watches[p.WatchID]; old != nil {
		old()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.agent.watches[p.WatchID] = cancel
	s.agent.mu.Unlock()
	go func() {
		previous := snapshot(path, p.Recursive)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				current := snapshot(path, p.Recursive)
				names := map[string]bool{}
				for name := range previous {
					names[name] = true
				}
				for name := range current {
					names[name] = true
				}
				for name := range names {
					before, bok := previous[name]
					after, aok := current[name]
					if !bok || !aok {
						s.writeText(event("fs.watch", map[string]any{"watchId": p.WatchID, "event": "rename", "filename": name}))
					} else if before != after {
						s.writeText(event("fs.watch", map[string]any{"watchId": p.WatchID, "event": "change", "filename": name}))
					}
				}
				previous = current
			}
		}
	}()
	return map[string]any{}, nil
}

func (s *session) unwatch(req request) (any, error) {
	var p struct {
		WatchID int `json:"watchId"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	s.agent.mu.Lock()
	if cancel := s.agent.watches[p.WatchID]; cancel != nil {
		cancel()
		delete(s.agent.watches, p.WatchID)
	}
	s.agent.mu.Unlock()
	return map[string]any{}, nil
}

func (s *session) spawn(req request) (any, error) {
	var p struct {
		Cmd      string            `json:"cmd"`
		Args     []string          `json:"args"`
		Env      map[string]string `json:"env"`
		Cwd      string            `json:"cwd"`
		Terminal *struct{ Cols, Rows uint16 }
		Output   bool `json:"output"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	s.agent.mu.Lock()
	if len(s.agent.processes) >= maxProcesses {
		s.agent.mu.Unlock()
		return nil, fail("ELIMIT", "process limit reached")
	}
	pid := s.agent.nextPID
	s.agent.nextPID++
	s.agent.mu.Unlock()
	commandPath, err := exec.LookPath(p.Cmd)
	if err != nil {
		return nil, fail("ENOENT", "executable not found: "+p.Cmd)
	}
	cmd := exec.Command(commandPath, p.Args...)
	cmd.Env = os.Environ()
	for k, v := range p.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if p.Cwd != "" {
		cwd, e := s.agent.root.resolve(p.Cwd, false)
		if e != nil {
			return nil, e
		}
		cmd.Dir = cwd
	} else {
		cmd.Dir = s.agent.root.root
	}
	outCh, inCh := s.allocateChannel(), uint32(1)
	s.agent.mu.Lock()
	if s.agent.nextChannel%2 == 0 {
		s.agent.nextChannel++
	}
	inCh = s.agent.nextChannel
	s.agent.nextChannel += 2
	s.agent.mu.Unlock()
	proc := &runningProcess{id: pid, cmd: cmd, outChannel: outCh, inChannel: inCh, session: s}
	var output io.ReadCloser
	if p.Terminal != nil {
		// pty.StartWithSize creates a new session whose id is also the process group id.
		terminal, e := pty.StartWithSize(cmd, &pty.Winsize{Cols: p.Terminal.Cols, Rows: p.Terminal.Rows})
		if e != nil {
			return nil, mapFsError(e)
		}
		proc.pty = terminal
		proc.stdin = terminal
		output = terminal
	} else {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		stdin, e := cmd.StdinPipe()
		if e != nil {
			return nil, fail("EPROTO", e.Error())
		}
		stdout, e := cmd.StdoutPipe()
		if e != nil {
			return nil, fail("EPROTO", e.Error())
		}
		cmd.Stderr = cmd.Stdout
		if e = cmd.Start(); e != nil {
			return nil, mapFsError(e)
		}
		proc.stdin = stdin
		output = stdout
	}
	s.agent.mu.Lock()
	s.agent.processes[pid] = proc
	s.agent.mu.Unlock()
	go s.streamProcess(proc, output, p.Output)
	return map[string]any{"pid": pid, "outCh": outCh, "inCh": inCh}, nil
}

func (s *session) streamProcess(proc *runningProcess, output io.ReadCloser, enabled bool) {
	if enabled {
		buffer := make([]byte, maxBinaryPayload)
		for {
			n, err := output.Read(buffer)
			if n > 0 {
				proc.deliver(buffer[:n])
			}
			if err != nil {
				break
			}
		}
	} else {
		_, _ = io.Copy(io.Discard, output)
	}
	waitErr := proc.cmd.Wait()
	code := processExitCode(waitErr)
	proc.finish(code)
	go func() {
		time.Sleep(60 * time.Second)
		s.agent.mu.Lock()
		if s.agent.processes[proc.id] == proc {
			delete(s.agent.processes, proc.id)
		}
		s.agent.mu.Unlock()
	}()
}

func (process *runningProcess) deliver(data []byte) {
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.session != nil && process.session.writeBinary(process.outChannel, data, false) == nil {
		return
	}
	process.session = nil
	process.buffered = append(process.buffered, data...)
	if excess := len(process.buffered) - initialChannelCredit; excess > 0 {
		copy(process.buffered, process.buffered[excess:])
		process.buffered = process.buffered[:initialChannelCredit]
	}
}

func (process *runningProcess) finish(code int) {
	process.mu.Lock()
	defer process.mu.Unlock()
	process.exitCode = &code
	if process.session != nil {
		process.session.writeText(event("proc.exit", map[string]any{"pid": process.id, "code": code}))
		_ = process.session.writeBinary(process.outChannel, nil, true)
	}
}

func (process *runningProcess) detach(session *session) {
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.session == session {
		process.session = nil
	}
}

func (process *runningProcess) bind(session *session) {
	process.mu.Lock()
	defer process.mu.Unlock()
	process.session = session
	if len(process.buffered) > 0 {
		if session.writeBinary(process.outChannel, process.buffered, false) != nil {
			process.session = nil
			return
		}
		process.buffered = nil
	}
	if process.exitCode != nil {
		session.writeText(event("proc.exit", map[string]any{"pid": process.id, "code": *process.exitCode}))
		_ = session.writeBinary(process.outChannel, nil, true)
	}
}

func processExitCode(waitErr error) int {
	if waitErr == nil {
		return 0
	}
	exit, ok := waitErr.(*exec.ExitError)
	if !ok {
		return 1
	}
	if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return exit.ExitCode()
}

func (s *session) resize(req request) (any, error) {
	var p struct {
		PID        int `json:"pid"`
		Cols, Rows uint16
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	s.agent.mu.Lock()
	proc := s.agent.processes[p.PID]
	s.agent.mu.Unlock()
	if proc != nil && proc.pty != nil {
		if err := pty.Setsize(proc.pty, &pty.Winsize{Cols: p.Cols, Rows: p.Rows}); err != nil {
			return nil, fail("EPROTO", err.Error())
		}
	}
	return map[string]any{}, nil
}
func (s *session) kill(req request) (any, error) {
	var p struct {
		PID int `json:"pid"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	s.agent.mu.Lock()
	proc := s.agent.processes[p.PID]
	s.agent.mu.Unlock()
	if proc == nil {
		return map[string]any{}, nil
	}
	_ = syscall.Kill(-proc.cmd.Process.Pid, syscall.SIGTERM)
	go func() {
		time.Sleep(2 * time.Second)
		s.agent.mu.Lock()
		_, alive := s.agent.processes[p.PID]
		s.agent.mu.Unlock()
		if alive {
			_ = syscall.Kill(-proc.cmd.Process.Pid, syscall.SIGKILL)
		}
	}()
	return map[string]any{}, nil
}

func (s *session) export(req request) (any, error) {
	var p struct {
		Path, Format       string
		Includes, Excludes []string
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	root, err := s.agent.root.resolve(p.Path, false)
	if err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	zw := zip.NewWriter(&buffer)
	err = filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			_, e := zw.Create(rel + "/")
			return e
		}
		header, e := zip.FileInfoHeader(info)
		if e != nil {
			return e
		}
		header.Name = rel
		if info.Mode()&os.ModeSymlink != 0 {
			target, e := os.Readlink(path)
			if e != nil {
				return e
			}
			writer, e := zw.CreateHeader(header)
			if e == nil {
				_, e = writer.Write([]byte(target))
			}
			return e
		}
		writer, e := zw.CreateHeader(header)
		if e != nil {
			return e
		}
		file, e := os.Open(path)
		if e != nil {
			return e
		}
		defer file.Close()
		_, e = io.Copy(writer, file)
		return e
	})
	closeErr := zw.Close()
	if err != nil {
		return nil, mapFsError(err)
	}
	if closeErr != nil {
		return nil, fail("EPROTO", closeErr.Error())
	}
	channel := s.allocateChannel()
	go s.writeBinary(channel, buffer.Bytes(), true)
	return map[string]any{"ch": channel}, nil
}
