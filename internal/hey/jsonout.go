package hey

import (
	"bytes"
	"encoding/json"
	"io"
)

// Every JSON the binary prints goes through here. HTML escaping is off because JSON.stringify
// never escapes < > &, and an agent comparing the two CLIs' output must see the same bytes.
// Encode appends the "\n" console.log would. (Go still writes U+2028/U+2029 as  / ,
// which JSON.stringify does not; it decodes to the same string and is the one accepted divergence.)
func marshalJSON(v any, indent bool) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if indent {
		encoder.SetIndent("", "  ")
	}
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeJSON(w io.Writer, v any, indent bool) (int, error) {
	out, err := marshalJSON(v, indent)
	if err != nil {
		return 0, err
	}
	return w.Write(out)
}
