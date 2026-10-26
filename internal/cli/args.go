package cli

import (
	"fmt"
	"slices"
)

// Flag mirrors the TS flag(): the value is whatever follows the first --name, even another
// --flag. A trailing --name has no value and reads as absent.
func Flag(rest []string, name string) (string, bool) {
	i := slices.Index(rest, "--"+name)
	if i == -1 || i+1 >= len(rest) {
		return "", false
	}
	return rest[i+1], true
}

// RequiredFlag is Flag plus the TS refusal: absent, or a value that is itself a --flag.
func RequiredFlag(rest []string, name, usage string) (string, error) {
	v, ok := Flag(rest, name)
	if !ok || len(v) >= 2 && v[:2] == "--" {
		return "", fmt.Errorf("--%s is required\n%s", name, usage)
	}
	return v, nil
}
