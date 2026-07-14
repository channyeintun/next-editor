package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

var version = "dev"

func main() {
	port := flag.Int("port", 8600, "HTTP listen port")
	workspace := flag.String("workspace", "/workspace/project", "workspace directory")
	flag.Parse()

	root, err := filepath.Abs(*workspace)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		log.Fatal(err)
	}

	agent := newAgent(root, *port)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/ws", agent.serveWS)
	mux.Handle("/proxy/", agent.proxyHandler())

	address := fmt.Sprintf(":%d", *port)
	log.Printf("remote runtime agent %s listening on %s (workspace %s)", version, address, root)
	log.Fatal(http.ListenAndServe(address, mux))
}
