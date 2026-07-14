package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"time"
)

func listeningPorts() map[int]bool {
	ports := map[int]bool{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		scanner.Scan()
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			address := fields[1]
			colon := strings.LastIndexByte(address, ':')
			if colon < 0 {
				continue
			}
			value, err := strconv.ParseInt(address[colon+1:], 16, 32)
			if err == nil {
				ports[int(value)] = true
			}
		}
		_ = file.Close()
	}
	return ports
}

func (s *session) watchPorts() {
	previous := listeningPorts()
	delete(previous, s.agent.port)
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-s.closed:
			return
		case <-ticker.C:
			current := listeningPorts()
			delete(current, s.agent.port)
			for port := range current {
				if !previous[port] {
					s.writeText(event("port", map[string]any{"port": port, "type": "open"}))
				}
			}
			for port := range previous {
				if !current[port] {
					s.writeText(event("port", map[string]any{"port": port, "type": "close"}))
				}
			}
			previous = current
		}
	}
}
