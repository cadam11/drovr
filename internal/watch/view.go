package watch

import "regexp"

const (
	DetailIndent = 6
	// ReasonBudget is how many characters of a reason must survive whatever the window: at
	// two fixed lines a 60-column terminal dropped the coupling note a 100-column one kept.
	ReasonBudget        = 200
	MouseEventsPerChunk = 8
)

var (
	VerdictColour = map[string]int{"GO": 32, "WAIT": 33, "STOP": 31, "RUN": 36}
	MouseEvents   = regexp.MustCompile(`\x1b\[<(\d+);(\d+);(\d+)([Mm])`)
)

// View is what the operator is doing to the screen: never persisted, never fetched. The zero
// value is the view watch starts with.
type View struct {
	Selected       int     `json:"selected"`
	Message        string  `json:"message"`
	ConfirmStop    bool    `json:"confirmStop"`
	ConfirmStart   bool    `json:"confirmStart"`
	Help           bool    `json:"help"`
	PreviewWarning *string `json:"previewWarning"`
}

// LineHit is what a rendered line stands for under the mouse; exactly one field is set, and
// a nil *LineHit is dead space.
type LineHit struct {
	Program *int `json:"program,omitempty"`
	Asks    *int `json:"asks,omitempty"`
	Keybar  *int `json:"keybar,omitempty"`
}
