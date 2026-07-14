package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	protocolVersion           = 1
	maxControlFrame           = 1 << 20
	maxBinaryPayload          = 256 << 10
	initialChannelCredit      = 256 << 10
	maxFileBytes              = 64 << 20
	maxMountBytes             = 256 << 20
	maxProcesses              = 64
	maxWatches                = 128
	binaryFIN            byte = 1
)

type request struct {
	Type   string          `json:"t"`
	ID     uint64          `json:"id"`
	Method string          `json:"m"`
	Params json.RawMessage `json:"p"`
}

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type rcpError struct {
	code string
	err  error
}

func (e *rcpError) Error() string     { return e.code + ": " + e.err.Error() }
func fail(code, message string) error { return &rcpError{code: code, err: errors.New(message)} }

func success(id uint64, result any) []byte {
	b, _ := json.Marshal(map[string]any{"t": "ok", "id": id, "r": result})
	return b
}

func failure(id uint64, err error) []byte {
	code := "EPROTO"
	message := err.Error()
	var re *rcpError
	if errors.As(err, &re) {
		code, message = re.code, re.err.Error()
	}
	b, _ := json.Marshal(map[string]any{
		"t": "err", "id": id, "e": wireError{Code: code, Message: message},
	})
	return b
}

func event(method string, params any) []byte {
	b, _ := json.Marshal(map[string]any{"t": "evt", "m": method, "p": params})
	return b
}

func binaryFrame(channel uint32, payload []byte, fin bool) ([]byte, error) {
	if channel == 0 || len(payload) > maxBinaryPayload {
		return nil, fail("ELIMIT", "invalid binary frame")
	}
	b := make([]byte, 5+len(payload))
	binary.LittleEndian.PutUint32(b, channel)
	if fin {
		b[4] = binaryFIN
	}
	copy(b[5:], payload)
	return b, nil
}

func parseBinaryFrame(frame []byte) (uint32, []byte, bool, error) {
	if len(frame) < 5 || len(frame)-5 > maxBinaryPayload {
		return 0, nil, false, fail("EPROTO", "malformed binary frame")
	}
	channel := binary.LittleEndian.Uint32(frame[:4])
	if channel == 0 || frame[4]&^binaryFIN != 0 {
		return 0, nil, false, fail("EPROTO", "invalid binary header")
	}
	return channel, frame[5:], frame[4]&binaryFIN != 0, nil
}

func decodeParams(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fail("EPROTO", fmt.Sprintf("invalid params: %v", err))
	}
	return nil
}
