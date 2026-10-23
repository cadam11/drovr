package hey

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const defaultEndpoint = "https://hey.drovr.app/mcp"

// The file is {"to"?: string, "from"?: string, "endpoint"?: "https://…"}; other keys are
// ignored, as the Node CLI's non-strict zod object ignores them.
type fileConfig struct {
	To       *string
	From     *string
	Endpoint string
}

func shapeError(path, issue string) error {
	return fmt.Errorf(`%s is not {"to"?: string, "from"?: string, "endpoint"?: "https://…"}: %s`, path, issue)
}

// zod's name for what JSON.parse produced, so the first issue reads as the Node CLI prints it.
func zodTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	default:
		return "object"
	}
}

// A present key must be a non-empty string; absent is nil. The issue text is zod's.
func nonBlankField(object map[string]any, key string) (*string, string) {
	value, present := object[key]
	if !present {
		return nil, ""
	}
	text, isString := value.(string)
	if !isString {
		return nil, "Expected string, received " + zodTypeName(value)
	}
	if text == "" {
		return nil, "String must contain at least 1 character(s)"
	}
	return &text, ""
}

func endpointField(object map[string]any) (string, string) {
	value, present := object["endpoint"]
	if !present {
		return defaultEndpoint, ""
	}
	text, isString := value.(string)
	if !isString {
		return "", "Expected string, received " + zodTypeName(value)
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" {
		return "", "Invalid url"
	}
	if !strings.HasPrefix(text, "https://") {
		return "", `Invalid input: must start with "https://"`
	}
	return text, ""
}

func readConfig(path string) (fileConfig, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return fileConfig{Endpoint: defaultEndpoint}, nil
	}
	if err != nil {
		return fileConfig{}, err
	}
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return fileConfig{}, fmt.Errorf("%s is not JSON: %s", path, err)
	}
	object, isObject := raw.(map[string]any)
	if !isObject {
		return fileConfig{}, shapeError(path, "Expected object, received "+zodTypeName(raw))
	}
	to, issue := nonBlankField(object, "to")
	if issue != "" {
		return fileConfig{}, shapeError(path, issue)
	}
	from, issue := nonBlankField(object, "from")
	if issue != "" {
		return fileConfig{}, shapeError(path, issue)
	}
	endpoint, issue := endpointField(object)
	if issue != "" {
		return fileConfig{}, shapeError(path, issue)
	}
	return fileConfig{To: to, From: from, Endpoint: endpoint}, nil
}

// A set variable wins even when empty: process.env.HEY_TO ?? config.to reads "" as present.
func envOr(lookupEnv func(string) (string, bool), key string, fallback *string) *string {
	if value, ok := lookupEnv(key); ok {
		return &value
	}
	return fallback
}

func configPath(home string) string { return filepath.Join(home, ".config", "hey.json") }

func configDefaults(lookupEnv func(string) (string, bool), home string) (to, from *string, endpoint string, err error) {
	file, err := readConfig(configPath(home))
	if err != nil {
		return nil, nil, "", err
	}
	return envOr(lookupEnv, "HEY_TO", file.To), envOr(lookupEnv, "HEY_FROM", file.From), file.Endpoint, nil
}
