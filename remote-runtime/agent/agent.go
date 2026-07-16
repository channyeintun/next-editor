package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type agent struct {
	root            jail
	port            int
	mu              sync.Mutex
	nextChannel     uint32
	nextPID         int
	processes       map[int]*runningProcess
	watches         map[int]context.CancelFunc
	resumeToken     string
	sessionEpoch    uint64
	initialized     bool
	resumeGrace     time.Duration
	onResumeExpired func()
}

type session struct {
	agent      *agent
	conn       *websocket.Conn
	writeMu    sync.Mutex
	ready      bool
	uploads    map[uint32]*upload
	credits    map[uint32]int64
	creditCond *sync.Cond
	closed     chan struct{}
	resuming   bool
	epoch      uint64
}

type upload struct {
	requestID uint64
	kind      string
	path      string
	buf       bytes.Buffer
}

type deferredResponse struct {
	result any
	after  func()
}

type runningProcess struct {
	id         int
	cmd        *exec.Cmd
	outChannel uint32
	inChannel  uint32
	stdin      io.WriteCloser
	pty        *os.File
	mu         sync.Mutex
	session    *session
	buffered   []byte
	exitCode   *int
}

func newResumeToken() string {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", tokenBytes)
}

func newAgent(root string, port int) *agent {
	return &agent{root: newJail(root), port: port, nextChannel: 2, nextPID: 1,
		processes: make(map[int]*runningProcess), watches: make(map[int]context.CancelFunc),
		resumeToken: newResumeToken(), resumeGrace: 60 * time.Second, onResumeExpired: func() {}}
}

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func (a *agent) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s := &session{agent: a, conn: conn, uploads: make(map[uint32]*upload),
		credits: make(map[uint32]int64), closed: make(chan struct{})}
	s.creditCond = sync.NewCond(&s.writeMu)
	go s.watchPorts()
	defer func() {
		close(s.closed)
		s.creditCond.Broadcast()
		_ = conn.Close()
		a.mu.Lock()
		for _, process := range a.processes {
			process.detach(s)
		}
		epoch := s.epoch
		a.mu.Unlock()
		if epoch != 0 {
			a.scheduleResumeExpiry(epoch)
		}
	}()
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch messageType {
		case websocket.TextMessage:
			if len(data) > maxControlFrame {
				s.writeText(failure(0, fail("ELIMIT", "control frame too large")))
				return
			}
			var envelope struct {
				Type   string          `json:"t"`
				Method string          `json:"m"`
				Params json.RawMessage `json:"p"`
			}
			if json.Unmarshal(data, &envelope) != nil {
				s.writeText(failure(0, fail("EPROTO", "malformed request")))
				continue
			}
			if envelope.Type == "evt" && envelope.Method == "ch.credit" {
				var p struct {
					Channel uint32 `json:"ch"`
					Bytes   int64  `json:"bytes"`
				}
				if decodeParams(envelope.Params, &p) == nil && p.Channel > 0 && p.Channel%2 == 0 &&
					p.Bytes > 0 && p.Bytes <= maxBinaryPayload {
					s.writeMu.Lock()
					if credit, ok := s.credits[p.Channel]; ok && credit <= int64(maxMountBytes)-p.Bytes {
						s.credits[p.Channel] += p.Bytes
						s.creditCond.Broadcast()
					}
					s.writeMu.Unlock()
				}
				continue
			}
			var req request
			if json.Unmarshal(data, &req) != nil || req.Type != "req" {
				s.writeText(failure(0, fail("EPROTO", "malformed request")))
				continue
			}
			if !s.ready && req.Method != "session.hello" {
				s.writeText(failure(req.ID, fail("EPROTO", "session.hello must be first")))
				continue
			}
			s.handle(req)
		case websocket.BinaryMessage:
			s.handleBinary(data)
		}
	}
}

func (a *agent) scheduleResumeExpiry(epoch uint64) {
	time.AfterFunc(a.resumeGrace, func() {
		a.mu.Lock()
		if a.sessionEpoch != epoch {
			a.mu.Unlock()
			return
		}
		a.sessionEpoch++
		a.resumeToken = newResumeToken()
		processes := a.processes
		a.processes = make(map[int]*runningProcess)
		for _, cancel := range a.watches {
			cancel()
		}
		a.watches = make(map[int]context.CancelFunc)
		a.mu.Unlock()

		for _, process := range processes {
			process.mu.Lock()
			active := process.exitCode == nil && process.cmd != nil && process.cmd.Process != nil
			pid := 0
			if active {
				pid = process.cmd.Process.Pid
			}
			process.mu.Unlock()
			if pid != 0 {
				_ = syscall.Kill(-pid, syscall.SIGKILL)
			}
		}
		if a.onResumeExpired != nil {
			a.onResumeExpired()
		}
	})
}

func (s *session) writeText(data []byte) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.WriteMessage(websocket.TextMessage, data)
}

func (s *session) writeBinary(channel uint32, data []byte, fin bool) error {
	_, err := s.writeBinaryProgress(channel, data, fin)
	return err
}

func (s *session) writeBinaryProgress(channel uint32, data []byte, fin bool) (int, error) {
	written := 0
	for len(data) > 0 {
		s.writeMu.Lock()
		for s.credits[channel] <= 0 {
			select {
			case <-s.closed:
				s.writeMu.Unlock()
				return written, io.ErrClosedPipe
			default:
			}
			s.creditCond.Wait()
		}
		n := len(data)
		if n > maxBinaryPayload {
			n = maxBinaryPayload
		}
		if int64(n) > s.credits[channel] {
			n = int(s.credits[channel])
		}
		s.credits[channel] -= int64(n)
		frame, _ := binaryFrame(channel, data[:n], false)
		err := s.conn.WriteMessage(websocket.BinaryMessage, frame)
		s.writeMu.Unlock()
		if err != nil {
			return written, err
		}
		data = data[n:]
		written += n
	}
	if fin {
		frame, _ := binaryFrame(channel, nil, true)
		s.writeMu.Lock()
		err := s.conn.WriteMessage(websocket.BinaryMessage, frame)
		s.writeMu.Unlock()
		return written, err
	}
	return written, nil
}

func (s *session) allocateChannel() uint32 {
	s.agent.mu.Lock()
	id := s.agent.nextChannel
	s.agent.nextChannel += 2
	s.agent.mu.Unlock()
	s.writeMu.Lock()
	s.credits[id] = initialChannelCredit
	s.writeMu.Unlock()
	return id
}

func (s *session) handle(req request) {
	result, err := s.dispatch(req)
	if err != nil {
		s.writeText(failure(req.ID, err))
		return
	}
	if result != nil {
		var after func()
		if deferred, ok := result.(deferredResponse); ok {
			result, after = deferred.result, deferred.after
		}
		response := success(req.ID, result)
		if len(response) > maxControlFrame {
			response = failure(req.ID, fail("ELIMIT", "control response exceeds 1 MiB"))
			after = nil
		}
		s.writeText(response)
		if req.Method == "session.hello" && s.resuming {
			s.bindProcesses()
		}
		if after != nil {
			after()
		}
	}
}

func (s *session) bindProcesses() {
	s.agent.mu.Lock()
	defer s.agent.mu.Unlock()
	for _, process := range s.agent.processes {
		s.writeMu.Lock()
		s.credits[process.outChannel] = initialChannelCredit
		s.writeMu.Unlock()
		process.bind(s)
	}
}

func (s *session) dispatch(req request) (any, error) {
	switch req.Method {
	case "session.hello":
		var p struct {
			ProtocolVersion int    `json:"protocolVersion"`
			ResumeToken     string `json:"resumeToken"`
		}
		if err := decodeParams(req.Params, &p); err != nil {
			return nil, err
		}
		if p.ProtocolVersion != protocolVersion {
			return nil, fail("EPROTO", "unsupported protocol version")
		}
		resumed := p.ResumeToken != ""
		s.agent.mu.Lock()
		if !resumed && s.agent.initialized {
			s.agent.mu.Unlock()
			return nil, fail("EGONE", "session already requires a resume token")
		}
		if resumed && p.ResumeToken != s.agent.resumeToken {
			s.agent.mu.Unlock()
			return nil, fail("EGONE", "resume token is no longer valid")
		}
		s.agent.sessionEpoch++
		s.agent.initialized = true
		s.epoch = s.agent.sessionEpoch
		resumeToken := s.agent.resumeToken
		s.agent.mu.Unlock()
		s.ready = true
		s.resuming = resumed
		return map[string]any{"workdir": s.agent.root.root, "agentVersion": version, "resumed": resumed, "resumeToken": resumeToken}, nil
	case "session.ping":
		return map[string]any{}, nil
	case "ch.credit":
		var p struct {
			Channel uint32 `json:"ch"`
			Bytes   int64  `json:"bytes"`
		}
		if err := decodeParams(req.Params, &p); err != nil {
			return nil, err
		}
		if p.Channel == 0 || p.Channel%2 != 0 || p.Bytes <= 0 || p.Bytes > maxBinaryPayload {
			return nil, fail("EPROTO", "invalid channel credit")
		}
		s.writeMu.Lock()
		credit, ok := s.credits[p.Channel]
		if ok && credit <= int64(maxMountBytes)-p.Bytes {
			s.credits[p.Channel] += p.Bytes
			s.creditCond.Broadcast()
		}
		s.writeMu.Unlock()
		if !ok {
			return nil, fail("EPROTO", "unknown channel")
		}
		return map[string]any{}, nil
	case "fs.readFile":
		return s.readFile(req)
	case "fs.writeFile":
		return s.startUpload(req, "write")
	case "mount":
		return s.startUpload(req, "mount")
	case "fs.mkdir":
		return s.mkdir(req)
	case "fs.readdir":
		return s.readdir(req)
	case "fs.rm":
		return s.remove(req)
	case "fs.rename":
		return s.rename(req)
	case "fs.watch":
		return s.watch(req)
	case "fs.unwatch":
		return s.unwatch(req)
	case "proc.spawn":
		return s.spawn(req)
	case "proc.resize":
		return s.resize(req)
	case "proc.kill":
		return s.kill(req)
	case "export":
		return s.export(req)
	default:
		return nil, fail("EPROTO", "unknown method "+req.Method)
	}
}

func (s *session) handleBinary(frame []byte) {
	channel, payload, fin, err := parseBinaryFrame(frame)
	if err != nil {
		s.writeText(event("fatal", map[string]string{"message": err.Error()}))
		return
	}
	upload := s.uploads[channel]
	if upload == nil {
		s.agent.mu.Lock()
		var proc *runningProcess
		for _, candidate := range s.agent.processes {
			if candidate.inChannel == channel {
				proc = candidate
				break
			}
		}
		s.agent.mu.Unlock()
		if proc == nil {
			s.writeText(event("fatal", map[string]string{"message": "unknown input channel"}))
			return
		}
		if len(payload) > 0 {
			_, _ = proc.stdin.Write(payload)
			s.writeText(event("ch.credit", map[string]any{"ch": channel, "bytes": len(payload)}))
		}
		if fin {
			_ = proc.stdin.Close()
		}
		return
	}
	limit := maxFileBytes
	if upload.kind == "mount" {
		limit = maxMountBytes
	}
	if upload.buf.Len()+len(payload) > limit {
		delete(s.uploads, channel)
		s.writeText(failure(upload.requestID, fail("ELIMIT", "upload too large")))
		return
	}
	_, _ = upload.buf.Write(payload)
	if len(payload) > 0 {
		s.writeText(event("ch.credit", map[string]any{"ch": channel, "bytes": len(payload)}))
	}
	if !fin {
		return
	}
	delete(s.uploads, channel)
	if upload.kind == "write" {
		path, resolveErr := s.agent.root.resolve(upload.path, true)
		if resolveErr == nil {
			resolveErr = os.WriteFile(path, upload.buf.Bytes(), 0o644)
		}
		if resolveErr != nil {
			s.writeText(failure(upload.requestID, mapFsError(resolveErr)))
			return
		}
	} else {
		destination, resolveErr := s.agent.root.resolve(upload.path, true)
		if resolveErr == nil {
			resolveErr = os.MkdirAll(filepath.Dir(destination), 0o755)
		}
		var staging string
		if resolveErr == nil {
			staging, resolveErr = os.MkdirTemp(filepath.Dir(destination), ".remote-mount-*")
		}
		if resolveErr == nil {
			resolveErr = unpackZip(bytes.NewReader(upload.buf.Bytes()), int64(upload.buf.Len()), staging)
		}
		if resolveErr == nil {
			resolveErr = mergeMount(staging, destination)
		}
		if staging != "" {
			_ = os.RemoveAll(staging)
		}
		if resolveErr != nil {
			var protocolError *rcpError
			if errors.As(resolveErr, &protocolError) {
				s.writeText(failure(upload.requestID, resolveErr))
			} else {
				s.writeText(failure(upload.requestID, mapFsError(resolveErr)))
			}
			return
		}
	}
	s.writeText(success(upload.requestID, map[string]any{}))
}

func (a *agent) proxyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trimmed := strings.TrimPrefix(r.URL.Path, "/proxy/")
		parts := strings.SplitN(trimmed, "/", 2)
		port, err := strconv.Atoi(parts[0])
		if err != nil || port < 1 || port > 65535 || port == a.port {
			http.Error(w, "invalid port", http.StatusBadRequest)
			return
		}
		path := "/"
		if len(parts) == 2 {
			path += parts[1]
		}
		target := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", port)}
		proxy := httputil.NewSingleHostReverseProxy(target)
		original := proxy.Director
		proxy.Director = func(req *http.Request) { original(req); req.URL.Path = path; req.Host = target.Host }
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, err.Error(), http.StatusBadGateway)
		}
		proxy.ServeHTTP(w, r)
	})
}

func (s *session) startUpload(req request, kind string) (any, error) {
	var p struct {
		Path       string `json:"path"`
		MountPoint string `json:"mountPoint"`
		Channel    uint32 `json:"ch"`
	}
	if err := decodeParams(req.Params, &p); err != nil {
		return nil, err
	}
	if p.Channel == 0 || p.Channel%2 == 0 {
		return nil, fail("EPROTO", "client upload channel must be odd")
	}
	path := p.Path
	if kind == "mount" {
		path = p.MountPoint
	}
	s.uploads[p.Channel] = &upload{requestID: req.ID, kind: kind, path: path}
	return nil, nil
}
