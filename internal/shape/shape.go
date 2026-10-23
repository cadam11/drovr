// Package shape decodes JSON against a zod schema field by field. zod has no Go twin; this
// is the subset drovr's schemas use, so every boundary refuses the same shapes with a path.
package shape

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// Object is one JSON object decoded field by field in the zod schema's order. The first
// refusal is kept in Err and every later step is skipped; unknown keys are stripped, as
// zod's .object() does.
type Object struct {
	Err    error
	fields map[string]json.RawMessage
	path   string
}

func Decode(raw json.RawMessage, path string) (*Object, error) {
	if IsNull(raw) {
		return nil, fmt.Errorf("%s: expected object, received null", OrRoot(path))
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("%s: expected object: %v", OrRoot(path), err)
	}
	return &Object{fields: fields, path: path}, nil
}

func IsNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func OrRoot(path string) string {
	if path == "" {
		return "(root)"
	}
	return path
}

func (o *Object) At(key string) string {
	if o.path == "" {
		return key
	}
	return o.path + "." + key
}

func (o *Object) Fail(err error) {
	if o.Err == nil {
		o.Err = err
	}
}

func (o *Object) Check(key string, ok bool, why string) {
	if !ok {
		o.Fail(fmt.Errorf("%s: %s", o.At(key), why))
	}
}

// Present is false for absent, for null and after a refusal; a caller that must refuse
// null checks for it first.
func (o *Object) Present(key string) (json.RawMessage, bool) {
	raw, ok := o.fields[key]
	return raw, ok && !IsNull(raw) && o.Err == nil
}

func into[T any](o *Object, key string, raw json.RawMessage, dst *T) {
	if err := json.Unmarshal(raw, dst); err != nil {
		o.Fail(fmt.Errorf("%s: %v", o.At(key), err))
	}
}

// Required refuses absent and null alike: a zod field with no default and no .nullable().
func Required[T any](o *Object, key string, dst *T) {
	if o.Err != nil {
		return
	}
	raw, ok := o.fields[key]
	if !ok || IsNull(raw) {
		o.Fail(fmt.Errorf("%s: required", o.At(key)))
		return
	}
	into(o, key, raw, dst)
}

// RequiredNullable is zod's .nullable() with no default: null is a value, absence is not.
func RequiredNullable[T any](o *Object, key string, dst *T) {
	if o.Err != nil {
		return
	}
	raw, ok := o.fields[key]
	if !ok {
		o.Fail(fmt.Errorf("%s: required", o.At(key)))
		return
	}
	if IsNull(raw) {
		var zero T
		*dst = zero
		return
	}
	into(o, key, raw, dst)
}

// Optional keeps dst's default when absent; null is refused, the field not being nullable.
func Optional[T any](o *Object, key string, dst *T) {
	raw, ok := o.fields[key]
	if !ok || o.Err != nil {
		return
	}
	if IsNull(raw) {
		o.Fail(fmt.Errorf("%s: expected a value, received null", o.At(key)))
		return
	}
	into(o, key, raw, dst)
}

// NullableDefault is .nullable().default(...): absent and null both keep dst's default.
func NullableDefault[T any](o *Object, key string, dst *T) {
	if raw, ok := o.Present(key); ok {
		into(o, key, raw, dst)
	}
}

// Each decodes an array element by element, naming the failing index.
func Each[T any](o *Object, key string, raw json.RawMessage, parse func(json.RawMessage, string) (T, error)) []T {
	var items []json.RawMessage
	if o.Err != nil {
		return nil
	}
	into(o, key, raw, &items)
	out := make([]T, 0, len(items))
	for i, item := range items {
		v, err := parse(item, fmt.Sprintf("%s[%d]", o.At(key), i))
		if err != nil {
			o.Fail(err)
			return nil
		}
		out = append(out, v)
	}
	return out
}

func OneOf[T ~string](o *Object, key string, value T, allowed []T) {
	names := make([]string, len(allowed))
	for i, a := range allowed {
		names[i] = string(a)
	}
	o.Check(key, slices.Contains(allowed, value), fmt.Sprintf("invalid enum value %q, expected %s", value, strings.Join(names, " | ")))
}
