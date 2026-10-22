// Command drovr is the Go port of src/cli.ts. The TypeScript is the oracle until cut-over:
// conformance_test.go diffs the two on the same DROVR_HOME.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"github.com/cadam11/drovr/internal/help"
)

// version is stamped by scripts/release.sh with -ldflags "-X main.version=<VERSION>".
var version = "dev"

// exitOne is a failure whose message has already been printed, so main exits 1 without adding a line.
type exitOne struct{}

func (exitOne) Error() string { return "exit 1" }

func main() {
	err := run(os.Args[1:], os.Stdout, os.Stderr)
	if err == nil {
		return
	}
	if !errors.As(err, new(exitOne)) {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(1)
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "")
		fmt.Fprintln(stdout, help.RenderList())
		return nil
	}
	cmd, rest := args[0], args[1:]
	asJSON := slices.Contains(rest, "--json")
	// `drovr <cmd> --help` reaches the same detail page as `drovr help <cmd>`.
	if _, ok := help.Find(cmd); ok && slices.Contains(rest, "--help") {
		return showHelp(stdout, &cmd, asJSON)
	}
	switch cmd {
	case "help", "--help", "-h":
		return showHelp(stdout, firstNonFlag(rest), asJSON)
	case "version", "--version":
		fmt.Fprintln(stdout, version)
		return nil
	}
	if _, ok := help.Find(cmd); ok {
		return notPorted(cmd, rest)
	}
	fmt.Fprintf(stderr, "unknown command \"%s\"\n\n", cmd)
	fmt.Fprintln(stdout, help.RenderList())
	return exitOne{}
}

func firstNonFlag(rest []string) *string {
	for i, a := range rest {
		if !strings.HasPrefix(a, "-") {
			return &rest[i]
		}
	}
	return nil
}

func showHelp(stdout io.Writer, topic *string, asJSON bool) error {
	if topic == nil && asJSON {
		return encode(stdout, help.TreeOf())
	}
	if topic == nil {
		fmt.Fprintln(stdout, help.RenderList())
		return nil
	}
	c, ok := help.Find(*topic)
	if !ok && asJSON {
		// The TS prints JSON.stringify(undefined) here, which console.log writes as "undefined", exit 0.
		fmt.Fprintln(stdout, "undefined")
		return nil
	}
	if !ok {
		return fmt.Errorf("no command named \"%s\" — run `drovr help` for the list", *topic)
	}
	if asJSON {
		return encode(stdout, c)
	}
	fmt.Fprintln(stdout, help.RenderCommand(c))
	return nil
}

// encode matches JSON.stringify(v, null, 2) plus console.log's newline: no HTML escaping, two-space indent.
func encode(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func notPorted(cmd string, rest []string) error {
	return fmt.Errorf("drovr %s is not ported to Go yet — run: node src/cli.ts %s", cmd, strings.Join(append([]string{cmd}, rest...), " "))
}
