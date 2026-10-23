package cycle

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
)

// sshTimeout is one ssh round trip to a host: a `cat`, an `rm`, a `true`. Same budget as an orca call.
const sshTimeout = 20 * time.Second

// Source is where a program's `last-cycle.json` is read from and cleared. The runner writes
// it with its own `drovr report`, so on a host it lands in the box's DROVR_HOME and comes
// back over ssh; the ledger it feeds stays on this Mac either way. Read is the file's text,
// or nil when there is none yet; a failure to look is returned, never read as absent.
type Source struct {
	Label string // names the file in messages
	Read  func(context.Context) (*string, error)
	Clear func(context.Context) error
}

// RemoteReportPath is built as a shell word, not resolved here: `~` is the box's home and
// only the box knows it.
func RemoteReportPath(h control.Host, program string) string {
	return h.DrovrHome + "/programs/" + program + "/last-cycle.json"
}

// IsMissingFile is cat's own complaint for an absent file; anything else ssh says is a real failure.
func IsMissingFile(stderr string) bool { return strings.Contains(stderr, "No such file") }

func SourceFor(p paths.Paths, program control.Program) Source {
	if program.Host == nil {
		return localSource(p.LastCycle(program.Name))
	}
	return hostedSource(*program.Host, RemoteReportPath(*program.Host, program.Name))
}

func localSource(path string) Source {
	return Source{
		Label: path,
		Read: func(context.Context) (*string, error) {
			b, err := os.ReadFile(path)
			if errors.Is(err, fs.ErrNotExist) {
				return nil, nil
			}
			if err != nil {
				return nil, err
			}
			text := string(b)
			return &text, nil
		},
		Clear: func(context.Context) error {
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
			return nil
		},
	}
}

func hostedSource(h control.Host, path string) Source {
	return Source{
		Label: h.SSH + ":" + path,
		Read: func(ctx context.Context) (*string, error) {
			res, err := exec.RunSsh(ctx, h.SSH, orca.ShellCommand([]string{"cat", path}), sshTimeout)
			if exitErr, ok := errors.AsType[*exec.ExitError](err); ok && IsMissingFile(exitErr.Stderr) {
				return nil, nil
			}
			if err != nil {
				return nil, err
			}
			return &res.Stdout, nil
		},
		Clear: func(ctx context.Context) error {
			_, err := exec.RunSsh(ctx, h.SSH, orca.ShellCommand([]string{"rm", "-f", path}), sshTimeout)
			return err
		},
	}
}

// ReadReport is strict, unlike ReportFromPoll: it reads a report the cycle has settled, so a
// torn or wrong-shaped file is an error.
func ReadReport(ctx context.Context, s Source) (*Report, error) {
	text, err := s.Read(ctx)
	if err != nil || text == nil {
		return nil, err
	}
	r, err := ParseReport([]byte(*text), s.Label)
	if err != nil {
		return nil, err
	}
	return &r, nil
}
