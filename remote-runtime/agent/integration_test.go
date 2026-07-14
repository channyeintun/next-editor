package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type testClient struct {
	t      *testing.T
	conn   *websocket.Conn
	nextID uint64
}

func dialTestClient(t *testing.T, serverURL, resumeToken string) *testClient {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &testClient{t: t, conn: conn}
	params := map[string]any{"protocolVersion": 1}
	if resumeToken != "" {
		params["resumeToken"] = resumeToken
	}
	client.request("session.hello", params)
	return client
}

func newTestClient(t *testing.T) (*testClient, func()) {
	t.Helper()
	a := newAgent(t.TempDir(), 8600)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", a.serveWS)
	mux.Handle("/proxy/", a.proxyHandler())
	server := httptest.NewServer(mux)
	client := dialTestClient(t, server.URL, "")
	return client, func() { _ = client.conn.Close(); server.Close() }
}

func (c *testClient) sendRequest(method string, params any) uint64 {
	c.t.Helper()
	c.nextID++
	frame := map[string]any{"t": "req", "id": c.nextID, "m": method, "p": params}
	if err := c.conn.WriteJSON(frame); err != nil {
		c.t.Fatal(err)
	}
	return c.nextID
}

func (c *testClient) request(method string, params any) json.RawMessage {
	c.t.Helper()
	id := c.sendRequest(method, params)
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			c.t.Fatal(err)
		}
		if kind != websocket.TextMessage {
			continue
		}
		var frame struct {
			Type   string          `json:"t"`
			ID     uint64          `json:"id"`
			Result json.RawMessage `json:"r"`
			Error  *wireError      `json:"e"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			c.t.Fatal(err)
		}
		if frame.ID != id {
			continue
		}
		if frame.Type == "err" {
			c.t.Fatalf("%s: %s", frame.Error.Code, frame.Error.Message)
		}
		return frame.Result
	}
}

func (c *testClient) grant(channel uint32) {
	c.t.Helper()
	if err := c.conn.WriteJSON(map[string]any{"t": "evt", "m": "ch.credit", "p": map[string]any{"ch": channel, "bytes": initialChannelCredit}}); err != nil {
		c.t.Fatal(err)
	}
}

func (c *testClient) collectChannel(channel uint32) string {
	c.t.Helper()
	c.grant(channel)
	var output strings.Builder
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			c.t.Fatal(err)
		}
		if kind != websocket.BinaryMessage {
			continue
		}
		ch, payload, fin, err := parseBinaryFrame(data)
		if err != nil {
			c.t.Fatal(err)
		}
		if ch != channel {
			continue
		}
		output.Write(payload)
		if fin {
			return output.String()
		}
	}
}

func TestAgentFilesystemRoundTrip(t *testing.T) {
	client, closeClient := newTestClient(t)
	defer closeClient()
	channel := uint32(1)
	id := client.sendRequest("fs.writeFile", map[string]any{"path": "hello.txt", "ch": channel})
	payload := []byte("hello over RCP")
	frame := make([]byte, 5+len(payload))
	binary.LittleEndian.PutUint32(frame, channel)
	copy(frame[5:], payload)
	if err := client.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		t.Fatal(err)
	}
	fin := make([]byte, 5)
	binary.LittleEndian.PutUint32(fin, channel)
	fin[4] = binaryFIN
	if err := client.conn.WriteMessage(websocket.BinaryMessage, fin); err != nil {
		t.Fatal(err)
	}
	for {
		_, data, err := client.conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		var response struct {
			Type string `json:"t"`
			ID   uint64 `json:"id"`
		}
		if json.Unmarshal(data, &response) == nil && response.ID == id {
			if response.Type != "ok" {
				t.Fatalf("write failed: %s", data)
			}
			break
		}
	}
	var result struct {
		Channel uint32 `json:"ch"`
	}
	if err := json.Unmarshal(client.request("fs.readFile", map[string]any{"path": "hello.txt"}), &result); err != nil {
		t.Fatal(err)
	}
	if got := client.collectChannel(result.Channel); got != "hello over RCP" {
		t.Fatalf("got %q", got)
	}
}

func TestAgentProcessAndPTY(t *testing.T) {
	client, closeClient := newTestClient(t)
	defer closeClient()
	var spawned struct {
		PID int    `json:"pid"`
		Out uint32 `json:"outCh"`
	}
	params := map[string]any{"cmd": "sh", "args": []string{"-c", "stty size"}, "env": map[string]string{}, "terminal": map[string]int{"cols": 91, "rows": 37}, "output": true}
	if err := json.Unmarshal(client.request("proc.spawn", params), &spawned); err != nil {
		t.Fatal(err)
	}
	if got := client.collectChannel(spawned.Out); !strings.Contains(got, "37 91") {
		t.Fatalf("unexpected PTY size output %q", got)
	}
}

func TestAgentResumeFlushesBufferedProcessOutput(t *testing.T) {
	a := newAgent(t.TempDir(), 8600)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", a.serveWS)
	server := httptest.NewServer(mux)
	defer server.Close()
	first := dialTestClient(t, server.URL, "")
	var spawned struct {
		Out uint32 `json:"outCh"`
	}
	params := map[string]any{"cmd": "sh", "args": []string{"-c", "sleep 0.1; printf resumed-output"}, "env": map[string]string{}, "output": true}
	if err := json.Unmarshal(first.request("proc.spawn", params), &spawned); err != nil {
		t.Fatal(err)
	}
	_ = first.conn.Close()
	time.Sleep(200 * time.Millisecond)
	second := dialTestClient(t, server.URL, a.resumeToken)
	defer second.conn.Close()
	if got := second.collectChannel(spawned.Out); !strings.Contains(got, "resumed-output") {
		t.Fatalf("missing buffered output: %q", got)
	}
}

func TestAgentReverseProxy(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "yes")
		_, _ = io.WriteString(w, r.Method+" "+r.URL.Path)
	}))
	defer backend.Close()
	var port int
	if _, err := fmt.Sscanf(backend.URL, "http://127.0.0.1:%d", &port); err != nil {
		t.Fatal(err)
	}
	a := newAgent(t.TempDir(), 8600)
	request := httptest.NewRequest(http.MethodPost, fmt.Sprintf("http://agent/proxy/%d/path", port), strings.NewReader("body"))
	response := httptest.NewRecorder()
	a.proxyHandler().ServeHTTP(response, request)
	if response.Code != 200 || response.Header().Get("X-Test") != "yes" || response.Body.String() != "POST /path" {
		t.Fatalf("unexpected proxy response: %d %s", response.Code, response.Body.String())
	}
}

func TestPortWatcherFindsListener(t *testing.T) {
	listener := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer listener.Close()
	var port int
	if _, err := fmt.Sscanf(listener.URL, "http://127.0.0.1:%d", &port); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if listeningPorts()[port] {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("listener port %d not found", port)
}
