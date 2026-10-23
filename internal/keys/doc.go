package keys

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"

	"github.com/cadam11/drovr/internal/jsnum"
)

// Doc is a JSON object that remembers key order, so a rewrite is JSON.stringify(raw, null, 2)
// of what JSON.parse read: same keys in the same order, numbers in shortest form, nulls kept.
// Values are *Doc, []any, string, float64, bool or nil.
//
// Two known gaps against V8, neither reachable from a control file drovr writes: integer-like
// keys ("2") keep file order where V8 hoists them first, and the string encoder writes
// U+2028/U+2029 escaped where JSON.stringify writes them raw.
type Doc struct {
	keys []string
	vals map[string]any
}

func (d *Doc) Get(key string) (any, bool) {
	v, ok := d.vals[key]
	return v, ok
}

// Set appends a new key and leaves an existing one in its place, as assignment does in JS.
func (d *Doc) Set(key string, v any) {
	if d.vals == nil {
		d.vals = map[string]any{}
	}
	if _, ok := d.vals[key]; !ok {
		d.keys = append(d.keys, key)
	}
	d.vals[key] = v
}

func decode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch tok {
	case json.Delim('{'):
		d := &Doc{}
		for dec.More() {
			key, err := dec.Token()
			if err != nil {
				return nil, err
			}
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			d.Set(key.(string), v) // a repeated key keeps its first place and its last value, as JSON.parse does
		}
		_, err := dec.Token()
		return d, err
	case json.Delim('['):
		list := []any{}
		for dec.More() {
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			list = append(list, v)
		}
		_, err := dec.Token()
		return list, err
	}
	return tok, nil
}

// encode writes compact JSON by hand, then lets json.Indent lay it out: Indent keeps number
// text verbatim and writes empty containers as {} and [], exactly as JSON.stringify does.
func encode(v any) ([]byte, error) {
	var compact, out bytes.Buffer
	if err := encodeValue(&compact, v); err != nil {
		return nil, err
	}
	if err := json.Indent(&out, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

func encodeValue(buf *bytes.Buffer, v any) error {
	switch v := v.(type) {
	case *Doc:
		return encodeDoc(buf, v)
	case []any:
		buf.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeValue(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			buf.WriteString("null") // JSON.stringify's answer for a non-finite number
			return nil
		}
		buf.WriteString(jsnum.String(v))
		return nil
	case string, bool, nil:
		return encodeScalar(buf, v)
	}
	return fmt.Errorf("keys: cannot encode a %T", v)
}

func encodeDoc(buf *bytes.Buffer, d *Doc) error {
	buf.WriteByte('{')
	for i, key := range d.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		if err := encodeScalar(buf, key); err != nil {
			return err
		}
		buf.WriteByte(':')
		if err := encodeValue(buf, d.vals[key]); err != nil {
			return err
		}
	}
	buf.WriteByte('}')
	return nil
}

// encodeScalar leaves <, > and & raw, as JSON.stringify does; json.Marshal would escape them.
func encodeScalar(buf *bytes.Buffer, v any) error {
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	buf.Truncate(buf.Len() - 1) // Encode's trailing newline
	return nil
}
