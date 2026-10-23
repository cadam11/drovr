package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/cadam11/drovr/internal/exec"
)

// ShadowLabel is a second agent running the Go tick in shadow beside the live one, so its
// decisions can be compared without it ever admitting a cycle.
const ShadowLabel = "tech.propra.drovr.shadow"

// ShadowLogName keeps the shadow's output out of tick.log and tick.err, which are the live
// tick's record.
const ShadowLogName = "tick-shadow"

// ShadowIntervalSeconds is 60 so every live decision has a shadow decision from the minute
// before it to be paired with.
const ShadowIntervalSeconds = 60

type PlistInput struct {
	Label, Binary   string
	Args            []string
	LogName         string
	IntervalSeconds int
	LogDir, Path    string
}

// Plist uses StartInterval, not a long-lived daemon: every firing is a fresh, crash-isolated
// process. The template matches the TS byte for byte except ProgramArguments, which names
// the Go binary itself instead of node plus a script.
func Plist(in PlistInput) string {
	var argv strings.Builder
	for _, a := range append([]string{in.Binary}, in.Args...) {
		argv.WriteString("    <string>" + a + "</string>\n")
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + in.Label + `</string>
  <key>ProgramArguments</key>
  <array>
` + argv.String() + `  </array>
  <key>StartInterval</key><integer>` + fmt.Sprint(in.IntervalSeconds) + `</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>` + filepath.Join(in.LogDir, in.LogName+".log") + `</string>
  <key>StandardErrorPath</key><string>` + filepath.Join(in.LogDir, in.LogName+".err") + `</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>` + in.Path + `</string></dict>
</dict>
</plist>
`
}

// AgentPath bakes the installing shell's PATH into the agent: launchd starts with a bare
// PATH that lacks tool dirs like ~/Library/pnpm, where teamclaude lives.
func AgentPath(inherited string) string {
	entries := append(strings.Split(inherited, ":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")
	seen := map[string]bool{"": true}
	var out []string
	for _, e := range entries {
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	return strings.Join(out, ":")
}

// Self is the binary the plist should name. Symlinks are resolved so the plist pins the real
// file; a brew upgrade that moves it then shows up as a BinaryMismatch until reinstalled.
func Self() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

type Reload string

const (
	Reloaded     Reload = "reloaded"
	Loaded       Reload = "loaded"
	ReloadFailed Reload = "failed"
)

func launchctl(ctx context.Context, args ...string) error {
	_, err := exec.RunBounded(ctx, "launchctl", args,
		exec.Bounds{Timeout: launchctlTimeout, Label: "launchctl " + args[0]})
	return err
}

// ReloadAgent boots the agent out and back in: launchd holds the plist it loaded, not the
// file on disk, so a rewrite alone silently keeps running the old definition. It takes an
// explicit label so the live and shadow agents can never be reloaded into each other's slot.
func ReloadAgent(ctx context.Context, label string) Reload {
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	wasLoaded := launchctl(ctx, "list", label) == nil
	if wasLoaded {
		// swallowed: the bootstrap below is what decides
		_ = launchctl(ctx, "bootout", domain+"/"+label)
	}
	if launchctl(ctx, "bootstrap", domain, PlistPathFor(label)) != nil {
		return ReloadFailed
	}
	if wasLoaded {
		return Reloaded
	}
	return Loaded
}

// InstallAgent writes the plist and always reloads it, for the reason ReloadAgent gives.
func InstallAgent(ctx context.Context, in PlistInput) (Reload, error) {
	target := PlistPathFor(in.Label)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return ReloadFailed, err
	}
	if err := os.WriteFile(target, []byte(Plist(in)), 0o644); err != nil {
		return ReloadFailed, err
	}
	return ReloadAgent(ctx, in.Label), nil
}

var programBinary = regexp.MustCompile(`<key>ProgramArguments</key>\s*<array>\s*<string>([^<]*)</string>`)

// PlistBinary is the binary an installed agent runs; false when there is no readable plist
// or it names none.
func PlistBinary(plistPath string) (string, bool) {
	raw, err := os.ReadFile(plistPath)
	if err != nil {
		return "", false
	}
	m := programBinary.FindSubmatch(raw)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
}

// BinaryMismatch says when the agent would fire a different binary than the one running —
// after a brew upgrade moved it, the tick keeps running the old one until reinstalled. A node
// binary is the shadow period, not a move: telling the operator to reinstall there would
// replace the Node service before any shadow day had been judged.
func BinaryMismatch(plistPath, self string) (string, bool) {
	bin, ok := PlistBinary(plistPath)
	if !ok || bin == self {
		return "", false
	}
	if filepath.Base(bin) == "node" {
		return "note: the live tick is the Node service; this binary runs as the shadow until cut-over", true
	}
	return "note: the launchd agent runs " + bin + " but this is " + self + " — re-run: drovr service install", true
}
