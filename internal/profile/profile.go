// Package profile seeds a program's hey sender profile from its Orca repo (src/profile.ts). A
// sender profile is decoration, so it is read leniently: a repo shape it does not know yields
// nothing, and an icon the phone cannot draw is dropped.
package profile

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/nudge"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
)

// LucideToSF maps the Lucide names Orca offers to the SF Symbol the phone draws. Unlisted means
// no icon and the monogram stays; a wrong glyph is worse than none. Extend by hand when a repo
// uses a new one.
var LucideToSF = map[string]string{
	"Globe":     "globe",
	"Rocket":    "paperplane.fill",
	"Bot":       "cpu",
	"Database":  "cylinder.split.1x2",
	"Server":    "server.rack",
	"Terminal":  "terminal",
	"Code":      "chevron.left.forwardslash.chevron.right",
	"Book":      "book",
	"Bug":       "ant",
	"Cloud":     "cloud",
	"Folder":    "folder",
	"Heart":     "heart",
	"Home":      "house",
	"Mail":      "envelope",
	"Megaphone": "megaphone",
	"Shield":    "shield",
	"Star":      "star",
	"Zap":       "bolt",
}

// Patch fields are in the order the TS assigns them, which is the order JSON.stringify writes.
type Patch struct {
	Icon    *string `json:"icon,omitempty"`
	Color   *string `json:"color,omitempty"`
	Summary *string `json:"summary,omitempty"`
}

// The keys present, in field order, for the log line.
func (p Patch) keys() []string {
	var keys []string
	for _, k := range []struct {
		name string
		v    *string
	}{{"icon", p.Icon}, {"color", p.Color}, {"summary", p.Summary}} {
		if k.v != nil {
			keys = append(keys, k.name)
		}
	}
	return keys
}

const maxRepos = 500

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// The three icon shapes `orca repo list --json` emits (read 2026-10-16).
type repoIcon struct {
	Type  string  `json:"type"`
	Emoji *string `json:"emoji"`
	Name  *string `json:"name"`
	Src   *string `json:"src"`
}

func iconFromRepo(raw json.RawMessage) *string {
	var icon repoIcon
	if json.Unmarshal(raw, &icon) != nil {
		return nil
	}
	var out string
	switch {
	case icon.Type == "emoji" && icon.Emoji != nil && hey.IconForm(*icon.Emoji) == "emoji":
		out = *icon.Emoji
	case icon.Type == "lucide" && icon.Name != nil && LucideToSF[*icon.Name] != "":
		out = "sf:" + LucideToSF[*icon.Name]
	// An https URL or a data URL within the Lambda's 32 KB; anything else the Lambda would refuse.
	case icon.Type == "image" && icon.Src != nil && hey.IconForm(*icon.Src) != "":
		out = *icon.Src
	default:
		return nil
	}
	return &out
}

// FromRepo is the patch an Orca repo seeds, or nil for nothing to seed or an unknown repo shape.
func FromRepo(repo json.RawMessage, description *string) *Patch {
	var r struct {
		ID         *string         `json:"id"`
		BadgeColor *string         `json:"badgeColor"`
		RepoIcon   json.RawMessage `json:"repoIcon"`
	}
	if json.Unmarshal(repo, &r) != nil || r.ID == nil {
		return nil
	}
	p := Patch{Icon: iconFromRepo(r.RepoIcon), Summary: description}
	if r.BadgeColor != nil && hexColor.MatchString(*r.BadgeColor) {
		p.Color = r.BadgeColor
	}
	if p.Icon == nil && p.Color == nil && p.Summary == nil {
		return nil
	}
	return &p
}

// FindRepo is the first of the first 500 repos whose id is repoID; nil when absent.
func FindRepo(repos []json.RawMessage, repoID string) json.RawMessage {
	if len(repos) > maxRepos {
		repos = repos[:maxRepos]
	}
	for _, repo := range repos {
		var r struct {
			ID *string `json:"id"`
		}
		if json.Unmarshal(repo, &r) == nil && r.ID != nil && *r.ID == repoID {
			return repo
		}
	}
	return nil
}

type SeedInput struct {
	Paths    paths.Paths
	Orca     *orca.Client
	Caller   nudge.CallerFunc
	NotifyTo *string
	Program  control.Program
	Out, Err io.Writer
	Now      epoch.Millis
}

// Seed runs once per program, after its terminal is up and never before: an avatar is not worth
// a late launch. Every failure is a log line and a retry at the next cycle start; a success —
// including "nothing to seed" — writes the marker, and `hey profile` is how the profile changes
// from then on.
func Seed(ctx context.Context, in SeedInput) {
	marker := in.Paths.ProfileSeeded(in.Program.Name)
	if in.NotifyTo == nil {
		return
	}
	if _, err := os.Stat(marker); err == nil {
		return
	}
	if err := seed(ctx, in, marker); err != nil {
		// swallowed: an avatar is not worth a failed cycle.
		fmt.Fprintf(in.Err, "%s: could not seed its hey profile (%v) — tried again at its next cycle start\n", in.Program.Name, err)
	}
}

func seed(ctx context.Context, in SeedInput, marker string) error {
	name := in.Program.Name
	repos, err := in.Orca.ListRepos(ctx)
	if err != nil {
		return err
	}
	repoID, err := in.Orca.WorktreeRepoID(ctx, in.Program)
	if err != nil {
		return err
	}
	patch := FromRepo(FindRepo(repos, repoID), in.Program.Description)
	if patch == nil {
		fmt.Fprintf(in.Out, "%s: nothing to seed into its hey profile (no Orca icon or colour, no description). To try again: rm %s\n", name, marker)
	} else {
		if err := setProfile(ctx, in, *patch); err != nil {
			return err
		}
		fmt.Fprintf(in.Out, "%s: seeded its hey profile (%s). Change it with: hey profile --from %s …; to seed again: rm %s\n",
			name, strings.Join(patch.keys(), ", "), name, marker)
	}
	if err := paths.EnsureDirs(in.Paths, name); err != nil {
		return err
	}
	// JSON.stringify does not escape &, < or >; an image URL's query string would otherwise.
	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(struct {
		SeededAt string `json:"seededAt"`
		Patch    *Patch `json:"patch"`
	}{epoch.ISO(in.Now), patch}); err != nil {
		return err
	}
	return os.WriteFile(marker, body.Bytes(), 0o644)
}

func setProfile(ctx context.Context, in SeedInput, p Patch) error {
	call, err := in.Caller()
	if err != nil {
		return err
	}
	return hey.SetProfile(ctx, call, hey.ProfileInput{To: *in.NotifyTo, From: in.Program.Name, Icon: p.Icon, Summary: p.Summary, Color: p.Color})
}
