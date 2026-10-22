// Command drovr is the Go port of src/cli.ts. The TypeScript is the oracle until cut-over:
// conformance_test.go diffs the two on the same DROVR_HOME.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// version is stamped by scripts/release.sh with -ldflags "-X main.version=<VERSION>".
var version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return notPorted("help", args)
	}
	switch args[0] {
	case "version", "--version":
		fmt.Fprintln(stdout, version)
		return nil
	}
	return notPorted(args[0], args[1:])
}

func notPorted(cmd string, rest []string) error {
	return fmt.Errorf("drovr %s is not ported to Go yet — run: node src/cli.ts %s", cmd, strings.Join(append([]string{cmd}, rest...), " "))
}
